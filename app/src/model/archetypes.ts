// Box archetype registry: each printable box type is ONE module entry that
// knows how to build itself, which fit guides the dieline-image wizard shows,
// and how to turn dragged guide positions back into parameters. The wizard is
// archetype-agnostic — adding the next box type (egg carton, pillow box…)
// means adding an entry here, not touching the UI.
//
// Each face's artwork is registered through the guides that bound it (see
// faceScope / dielineFit.faceImageMaps), so a picture whose matching panels
// disagree — common in AI-drawn and hand-drawn dielines — still puts every
// panel's art on its own panel.
//
// Guide contract (the wizard anchors the image on these): every archetype has
// x-guide 'c0' at flat x = 0, y-guide 'body0' at flat y = 0 and y-guide
// 'bodyH' at the body height. All guide positions are flat cm, y up.

import type { Template } from '../state/store'
import type { PaperDoc } from './document'
import { buildGableCarton, resolveDims, type GableDims } from './gable'
import { buildTuckBox, resolveTuck, type TuckParams } from './tuck'
import { buildCrossBox, resolveCross, type CrossParams } from './crossbox'

export type ArchetypeId = 'tuck' | 'gable' | 'cross'

export interface Guide {
  id: string
  label: string
  pos: number
}

export interface GuideSet {
  x: Guide[]
  y: Guide[]
}

/** Guide positions by id, flat cm. */
export interface GuidePositions {
  x: Record<string, number>
  y: Record<string, number>
}

/** A layout toggle shown in the wizard (e.g. glue side). */
export interface ArchetypeOption {
  key: string
  label: string
  choices: Array<{ value: string; label: string }>
}

export interface Archetype<P> {
  id: ArchetypeId
  label: string
  /** Store template to build with (also picks the authored fold steps). */
  template: Template
  defaults: P
  /** Layout toggles; a function when choice labels depend on the params. */
  options: ArchetypeOption[] | ((p: P) => ArchetypeOption[])
  optionsOf(p: P): Record<string, string>
  withOptions(p: P, o: Record<string, string>): P
  /** Which side the glue flap sits on for these params (drives column guessing). */
  glueSide(p: P): 'left' | 'right'
  /** Columns in flat order are wide-first (W D W D) vs narrow-first (D W D W). */
  wideFirst(p: P): boolean
  build(p: P): PaperDoc
  guides(p: P): GuideSet
  /**
   * Inverse of guides(): positions → params, plus `mismatch` (0..1) — how far
   * the picture's two wide / two narrow columns are from repeating.
   */
  fromGuides(g: GuidePositions, prev: P): { params: P; mismatch: number }
  /**
   * y-guides that must stay in order with each other, one list per group
   * (default: all of them). Guides in different groups may cross — e.g. a
   * side wall drawn shorter than the front it hangs off.
   */
  yGroups?: string[][]
  /**
   * Which guides register a face's artwork (default: all). A face's picture
   * region is read off these guides only.
   */
  faceScope?(faceName: string): { x: string[]; y: string[] }
}

/** The archetype's layout toggles for these params. */
export function archetypeOptions<P>(arch: Archetype<P>, p: P): ArchetypeOption[] {
  return typeof arch.options === 'function' ? arch.options(p) : arch.options
}

/** Tuck box: the flat column (1..4) carrying the top lid. */
function topLidPanel(p: TuckParams): number {
  return resolveTuck(p).topLidCol + 1
}

/** Column guide ids, flat order. */
export const COLUMN_GUIDES = ['c0', 'c1', 'c2', 'c3', 'c4'] as const

const COLUMN_LABELS = ['panel 1', '1 | 2', '2 | 3', '3 | 4', 'panel 4']

function columnGuides(colX: number[], colW: number[]): Guide[] {
  const xs = [...colX, colX[3] + colW[3]]
  return xs.map((pos, i) => ({ id: COLUMN_GUIDES[i], label: COLUMN_LABELS[i], pos }))
}

/** Column widths from guide positions, plus the W/D repeat error. */
function columnsFrom(g: GuidePositions, wideFirst: boolean) {
  const c = COLUMN_GUIDES.map((id) => g.x[id])
  const cols = [c[1] - c[0], c[2] - c[1], c[3] - c[2], c[4] - c[3]]
  const [w1, w2] = wideFirst ? [cols[0], cols[2]] : [cols[1], cols[3]]
  const [d1, d2] = wideFirst ? [cols[1], cols[3]] : [cols[0], cols[2]]
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9)
  return {
    width: Math.max(0.1, (w1 + w2) / 2),
    depth: Math.max(0.1, (d1 + d2) / 2),
    left: c[0],
    right: c[4],
    mismatch: Math.max(rel(w1, w2), rel(d1, d2)),
  }
}

// ---------------------------------------------------------------------------

const tuck: Archetype<TuckParams> = {
  id: 'tuck',
  label: 'Tuck-end box',
  template: 'tuckbox',
  defaults: { width: 6, depth: 3, height: 9, style: 'reverse', order: 'front-first', glueSide: 'right', lidOn: 'first' },
  // The picture decides: the user reads which column the top lid stands on and
  // whether the bottom lid hangs off the same column or the one opposite.
  // Panel order (wide first or narrow first) follows from the lid column.
  options: (p) => {
    const top = topLidPanel(p)
    const opposite = ((top + 1) % 4) + 1
    return [
      {
        key: 'topLid',
        label: 'Top lid on',
        choices: [1, 2, 3, 4].map((n) => ({ value: String(n), label: `Panel ${n}` })),
      },
      {
        key: 'style',
        label: 'Bottom lid on',
        choices: [
          { value: 'reverse', label: `Panel ${opposite} (reverse)` },
          { value: 'straight', label: `Panel ${top} (straight)` },
        ],
      },
      {
        key: 'glueSide',
        label: 'Glue flap',
        choices: [
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ],
      },
    ]
  },
  optionsOf: (p) => ({ topLid: String(topLidPanel(p)), style: p.style, glueSide: p.glueSide }),
  withOptions: (p, o) => {
    // 'topLid' (1..4) is the wizard's toggle; 'order' / 'lidOn' are the
    // builder's own params (the initial guess sets those directly).
    const lid = o.topLid ? Number(o.topLid) - 1 : -1
    return {
      ...p,
      style: (o.style ?? p.style) as TuckParams['style'],
      order: lid >= 0 ? (lid % 2 === 0 ? 'front-first' : 'side-first') : ((o.order ?? p.order) as TuckParams['order']),
      lidOn: lid >= 0 ? (lid < 2 ? 'first' : 'second') : ((o.lidOn ?? p.lidOn) as TuckParams['lidOn']),
      glueSide: (o.glueSide ?? p.glueSide) as TuckParams['glueSide'],
    }
  },
  glueSide: (p) => p.glueSide,
  wideFirst: (p) => p.order === 'front-first',
  build: (p) => buildTuckBox(p),
  guides(p) {
    const r = resolveTuck(p)
    const total = r.colX[3] + r.colW[3]
    return {
      x: [
        ...columnGuides(r.colX, r.colW),
        { id: 'glue', label: 'glue edge', pos: p.glueSide === 'right' ? total + r.GLUE : -r.GLUE },
      ],
      y: [
        { id: 'botTuck', label: 'bottom tuck', pos: -(r.LID + r.TUCK) },
        { id: 'body0', label: 'body bottom', pos: 0 },
        { id: 'bodyH', label: 'body top', pos: r.H },
        { id: 'topTuck', label: 'top tuck', pos: r.H + r.LID + r.TUCK },
      ],
    }
  },
  fromGuides(g, prev) {
    const c = columnsFrom(g, prev.order === 'front-first')
    const height = Math.max(0.1, g.y.bodyH - g.y.body0)
    // Lids span the depth, so each tuck is what's left past lid = depth.
    const top = g.y.topTuck - g.y.bodyH - c.depth
    const bot = g.y.body0 - g.y.botTuck - c.depth
    const glue = prev.glueSide === 'right' ? g.x.glue - c.right : c.left - g.x.glue
    return {
      params: {
        ...prev,
        width: c.width,
        depth: c.depth,
        height,
        lid: undefined,
        dust: undefined,
        tuck: Math.max(0.3, (top + bot) / 2),
        glue: Math.max(0.3, glue),
      },
      mismatch: c.mismatch,
    }
  },
}

const gable: Archetype<GableDims> = {
  id: 'gable',
  label: 'Gable-top carton',
  template: 'gable',
  defaults: { width: 5, depth: 3.2, height: 13, gable: 2.4, rib: 0.9, botFB: 2.2, botLR: 1.8, glue: 1.2 },
  options: [],
  optionsOf: () => ({}),
  withOptions: (p) => p,
  glueSide: () => 'right',
  wideFirst: () => true,
  build: (p) => buildGableCarton(p),
  guides(p) {
    const d = resolveDims(p)
    const colX = [0, d.W, d.W + d.D, 2 * d.W + d.D]
    const colW = [d.W, d.D, d.W, d.D]
    return {
      x: [...columnGuides(colX, colW), { id: 'glue', label: 'glue edge', pos: 2 * d.W + 2 * d.D + d.GLUE }],
      y: [
        { id: 'botFlap', label: 'bottom flaps', pos: -d.BOT_FB },
        { id: 'body0', label: 'body bottom', pos: 0 },
        { id: 'bodyH', label: 'body top', pos: d.H },
        { id: 'gableTop', label: 'roof top', pos: d.H + d.G },
        { id: 'ribTop', label: 'rib top', pos: d.H + d.G + d.R },
      ],
    }
  },
  fromGuides(g, prev) {
    const c = columnsFrom(g, true)
    const height = Math.max(0.1, g.y.bodyH - g.y.body0)
    const botFB = Math.max(0.3, g.y.body0 - g.y.botFlap)
    return {
      params: {
        ...prev,
        width: c.width,
        depth: c.depth,
        height,
        // The roof must reach the ridge: gable > depth / 2.
        gable: Math.max(g.y.gableTop - g.y.bodyH, c.depth * 0.51 * 1.02),
        rib: Math.max(0.2, g.y.ribTop - g.y.gableTop),
        botFB,
        botLR: botFB * (1.8 / 2.2),
        glue: Math.max(0.3, g.x.glue - c.right),
      },
      mismatch: c.mismatch,
    }
  },
}

const CROSS_Y_CENTER = ['topTuck', 'lid', 'bodyH', 'body0', 'bottom', 'back', 'backTab']
const CROSS_Y_SIDE = ['sideDustTop', 'sideTop', 'sideBot', 'sideDustBot']

const cross: Archetype<CrossParams> = {
  id: 'cross',
  label: 'Cross box',
  template: 'crossbox',
  defaults: { width: 6, depth: 5, height: 6 },
  options: [],
  optionsOf: () => ({}),
  withOptions: (p) => p,
  glueSide: () => 'right',
  wideFirst: () => true,
  build: (p) => buildCrossBox(p),
  guides(p) {
    const { W, D, H, TUCK, TAB, DUST, FLAP } = resolveCross(p)
    return {
      x: [
        { id: 'flapL', label: 'left flap edge', pos: -D - FLAP },
        { id: 'sideL', label: 'left side | flap', pos: -D },
        { id: 'c0', label: 'side | front', pos: 0 },
        { id: 'c1', label: 'front | side', pos: W },
        { id: 'sideR', label: 'right side | flap', pos: W + D },
        { id: 'flapR', label: 'right flap edge', pos: W + D + FLAP },
      ],
      y: [
        { id: 'topTuck', label: 'top tuck', pos: H + D + TUCK },
        { id: 'lid', label: 'lid | tuck', pos: H + D },
        { id: 'bodyH', label: 'front top', pos: H },
        { id: 'body0', label: 'front bottom', pos: 0 },
        { id: 'bottom', label: 'bottom | back', pos: -D },
        { id: 'back', label: 'back | tab', pos: -D - H },
        { id: 'backTab', label: 'tab end', pos: -D - H - TAB },
        { id: 'sideDustTop', label: 'side flap top', pos: H + DUST },
        { id: 'sideTop', label: 'side top', pos: H },
        { id: 'sideBot', label: 'side bottom', pos: 0 },
        { id: 'sideDustBot', label: 'side flap bottom', pos: -DUST },
      ],
    }
  },
  fromGuides(g, prev) {
    const x = g.x
    const y = g.y
    const width = Math.max(0.1, x.c1 - x.c0)
    const height = Math.max(0.1, y.bodyH - y.body0)
    // The lid, the bottom and both sides all span the depth.
    const depths = [y.lid - y.bodyH, y.body0 - y.bottom, x.c0 - x.sideL, x.sideR - x.c1].map((d) => Math.max(0.1, d))
    const depth = depths.reduce((a, b) => a + b) / depths.length
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9)
    const mismatch = Math.max(
      rel(Math.min(...depths), Math.max(...depths)),
      rel(y.bottom - y.back, height),
      rel(y.sideTop - y.sideBot, height),
    )
    return {
      params: {
        ...prev,
        width,
        depth,
        height,
        tuck: Math.max(0.3, y.topTuck - y.lid),
        tab: Math.max(0.3, y.back - y.backTab),
        dust: Math.max(0.3, (y.sideDustTop - y.sideTop + (y.sideBot - y.sideDustBot)) / 2),
        flap: Math.max(0.3, (x.sideL - x.flapL + (x.flapR - x.sideR)) / 2),
      },
      mismatch,
    }
  },
  yGroups: [CROSS_Y_CENTER, CROSS_Y_SIDE],
  faceScope(name) {
    if (/^left side/.test(name)) return { x: ['flapL', 'sideL', 'c0'], y: CROSS_Y_SIDE }
    if (/^right side/.test(name)) return { x: ['c1', 'sideR', 'flapR'], y: CROSS_Y_SIDE }
    return { x: ['c0', 'c1'], y: CROSS_Y_CENTER }
  },
}

export const ARCHETYPES: Record<ArchetypeId, Archetype<unknown>> = {
  tuck: tuck as Archetype<unknown>,
  gable: gable as Archetype<unknown>,
  cross: cross as Archetype<unknown>,
}

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as ArchetypeId[]
