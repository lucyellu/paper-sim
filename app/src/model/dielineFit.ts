// Fit-the-grid math for the dieline-image wizard: guide lines live in IMAGE
// pixels (what the user drags); a real body height turns them into flat cm
// (uniform scale, anchored on guides c0 / body0), the archetype turns those
// into params, and the same mapping registers the image onto the built sheet
// as an OverlayTransform. Also: print-DPI / one-Letter-page sizing and the
// rules-based initial guess from the raster analyzer. Pure (no DOM).

import { ARCHETYPES, COLUMN_GUIDES, type Archetype, type ArchetypeId, type GuidePositions } from './archetypes'
import { sheetBounds, type PaperDoc, type Vec2 } from './document'
import type { DielineImageAnalysis } from './dielineImage'
import type { OverlayTransform } from './material'
import type { RGBAImage } from './photoUnwarp'
import { fitsOneLetterPage } from './printFit'

/** Guide positions in image px, by id (x = columns, y = rows; image y grows down). */
export interface ImageGuides {
  x: Record<string, number>
  y: Record<string, number>
}

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** Everything needed to reopen the wizard ("Re-fit…"). Session-only. */
export interface FitSession {
  fileName: string
  /** The original picture (data URL). */
  source: string
  rotation: 0 | 90 | 180 | 270
  flipH: boolean
  /** Crop in rotated/flipped-image px; null = whole image. */
  crop: CropRect | null
  /** The baked (rotated + flipped + cropped) picture every later step uses. */
  image: string
  imageW: number
  imageH: number
  archetype: ArchetypeId
  params: unknown
  guides: ImageGuides
  heightCm: number
}

/** Params every archetype shares (used to rescale guesses generically). */
interface BoxLike {
  width: number
  depth: number
  height: number
}

export const MIN_PRINT_DPI = 150

// ---------------------------------------------------------------------------
// Image px ↔ flat cm

export function cmPerPx(g: ImageGuides, heightCm: number): number {
  return heightCm / Math.max(1e-6, g.y.body0 - g.y.bodyH)
}

export function guidesToFlat(g: ImageGuides, heightCm: number): GuidePositions {
  const k = cmPerPx(g, heightCm)
  const x: Record<string, number> = {}
  const y: Record<string, number> = {}
  for (const [id, px] of Object.entries(g.x)) x[id] = (px - g.x.c0) * k
  for (const [id, py] of Object.entries(g.y)) y[id] = (g.y.body0 - py) * k
  return { x, y }
}

/** Flat cm → image px for the current guides. */
export function flatToImage(g: ImageGuides, heightCm: number): (p: Vec2) => Vec2 {
  const k = cmPerPx(g, heightCm)
  return (p) => ({ x: g.x.c0 + p.x / k, y: g.y.body0 - p.y / k })
}

export function fitParams(
  arch: Archetype<unknown>,
  g: ImageGuides,
  heightCm: number,
  prev: unknown,
): { params: unknown; mismatch: number } {
  return arch.fromGuides(guidesToFlat(g, heightCm), prev)
}

/**
 * The overlay placement that puts image pixel (u, v) at flat
 * ((u − c0)·k, (body0 − v)·k) — as fractions of the doc's sheet bounds, the
 * way buildSheetCanvas draws overlays (canvas row 0 = sheet max.y).
 */
export function overlayForFit(
  doc: PaperDoc,
  g: ImageGuides,
  heightCm: number,
  imgW: number,
  imgH: number,
): OverlayTransform {
  const k = cmPerPx(g, heightCm)
  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 1e-6)
  const h = Math.max(max.y - min.y, 1e-6)
  return {
    offsetX: (-g.x.c0 * k - min.x) / w,
    offsetY: (max.y - g.y.body0 * k) / h,
    scaleX: (k * imgW) / w,
    scaleY: (k * imgH) / h,
    rotationDeg: 0,
  }
}

/** Print resolution of the artwork at this size (image px per inch). */
export function artDpi(g: ImageGuides, heightCm: number): number {
  return 2.54 / cmPerPx(g, heightCm)
}

export function sheetSize(doc: PaperDoc): { w: number; h: number } {
  const { min, max } = sheetBounds(doc)
  return { w: max.x - min.x, h: max.y - min.y }
}

/** Largest body height (cm) whose sheet still prints on one Letter page. */
export function fitLetterHeight(arch: Archetype<unknown>, g: ImageGuides, prev: unknown): number {
  let lo = 0.5
  let hi = 80
  for (let i = 0; i < 36; i++) {
    const m = (lo + hi) / 2
    const s = sheetSize(arch.build(fitParams(arch, g, m, prev).params))
    if (fitsOneLetterPage(s.w, s.h, 0.2)) lo = m
    else hi = m
  }
  return Math.floor(lo * 10) / 10
}

/** Largest body height (cm) at which the art still prints at ≥ `dpi`. */
export function sharpHeight(g: ImageGuides, dpi = MIN_PRINT_DPI): number {
  return Math.floor(((2.54 * (g.y.body0 - g.y.bodyH)) / dpi) * 10) / 10
}

// ---------------------------------------------------------------------------
// Initial guess

/**
 * Foreground = differs from the median border color by more than `threshold`
 * (sum of channel differences), or is opaque on a transparent picture. The
 * default is sensitive on purpose: pastel flaps on cream paper differ by ~35.
 */
export function foregroundMask(img: RGBAImage, threshold = 24): Uint8Array {
  const { width: w, height: h, data } = img
  const border: number[][] = [[], [], [], []]
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4
    for (let c = 0; c < 4; c++) border[c].push(data[i + c])
  }
  for (let x = 0; x < w; x += 2) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y += 2) {
    push(0, y)
    push(w - 1, y)
  }
  const med = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1])
  const alphaMode = med[3] < 128
  const mask = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (data[p + 3] < 32) continue
    mask[i] = alphaMode
      ? 1
      : Math.abs(data[p] - med[0]) + Math.abs(data[p + 1] - med[1]) + Math.abs(data[p + 2] - med[2]) > threshold
        ? 1
        : 0
  }
  return mask
}

/** Fraction of foreground pixels in the px rect [x0,x1)×[y0,y1). */
export function coverage(mask: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number {
  const xa = Math.max(0, Math.round(Math.min(x0, x1)))
  const xb = Math.min(w, Math.round(Math.max(x0, x1)))
  const ya = Math.max(0, Math.round(Math.min(y0, y1)))
  const yb = Math.min(h, Math.round(Math.max(y0, y1)))
  let n = 0
  let on = 0
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      n++
      on += mask[y * w + x]
    }
  }
  return n === 0 ? 0 : on / n
}

export interface ColumnGuess {
  /** The five body column lines c0..c4 (px). */
  lines: number[]
  glue: number
  cost: number
  wideFirst: boolean
}

/**
 * Pick the five body column lines (from the detected lines plus the drawing's
 * edges) so the columns repeat best — two wide + two narrow alternating —
 * with a narrow glue strip beyond them on `glueSide`. Width the layout leaves
 * unexplained (a watermark, a shadow) costs a little; `columnCost` (when
 * given) adds image evidence per column strip.
 */
export function bestColumns(
  cands: number[],
  bx0: number,
  bx1: number,
  glueSide: 'left' | 'right',
  wideFirst?: boolean,
  columnCost?: (x0: number, x1: number) => number,
): ColumnGuess | null {
  const span = bx1 - bx0
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b, 1e-9)
  const pts = [...new Set([bx0, ...cands, bx1])].sort((a, b) => a - b)
  const n = pts.length
  let best: ColumnGuess | null = null
  const idx = [0, 0, 0, 0, 0]
  const visit = (depth: number, from: number) => {
    if (depth === 5) {
      const lines = idx.map((i) => pts[i])
      const cols = [lines[1] - lines[0], lines[2] - lines[1], lines[3] - lines[2], lines[4] - lines[3]]
      if (cols.some((w) => w < span * 0.04)) return
      const minCol = Math.min(...cols)
      // Glue edge: the farthest line beyond the body that is still glue-narrow.
      let glue = NaN
      for (const p of pts) {
        const w = glueSide === 'right' ? p - lines[4] : lines[0] - p
        if (w >= span * 0.01 && w <= minCol * 0.8 && !(Math.abs(w) < Math.abs(glue))) glue = w
      }
      let cost = rel(cols[0], cols[2]) + rel(cols[1], cols[3])
      if (Number.isNaN(glue)) {
        glue = minCol * 0.3
        cost += 0.6
      }
      cost += (((lines[0] - bx0) + (bx1 - lines[4]) - glue) / span) * 0.8
      if (columnCost) for (let i = 0; i < 4; i++) cost += columnCost(lines[i], lines[i + 1])
      const wf = cols[0] + cols[2] >= cols[1] + cols[3]
      if (wideFirst !== undefined && wideFirst !== wf) cost += 0.6
      if (!best || cost < best.cost) {
        best = { lines, glue: glueSide === 'right' ? lines[4] + glue : lines[0] - glue, cost, wideFirst: wf }
      }
      return
    }
    for (let i = from; i <= n - (5 - depth); i++) {
      idx[depth] = i
      visit(depth + 1, i + 1)
    }
  }
  visit(0, 0)
  return best
}

/** Multiply every numeric field (lengths) of a params object by `s`. */
function scaleParams<P>(p: P, s: number): P {
  const out = { ...(p as Record<string, unknown>) }
  for (const [k, v] of Object.entries(out)) if (typeof v === 'number') out[k] = v * s
  return out as P
}

/**
 * Initial guide placement for an archetype on a (baked) picture: columns from
 * the analyzer's line candidates, body band from its horizontal lines, the
 * outermost rows snapped to the drawing's extent, and — when a foreground
 * mask is given — lid placement read off which wide panel has a flap. Falls
 * back to the archetype's default proportions laid into the content box.
 * `lockLayout` keeps the params' glue side / panel order instead of guessing.
 */
export function initialFit(
  archId: ArchetypeId,
  prev: unknown,
  a: DielineImageAnalysis,
  imgW: number,
  imgH: number,
  mask?: Uint8Array,
  lockLayout = false,
): { guides: ImageGuides; params: unknown } {
  const arch = ARCHETYPES[archId]
  const sx = imgW / a.imageW
  const sy = imgH / a.imageH
  const box = a.content
    ? { x0: a.content.x * sx, x1: (a.content.x + a.content.w) * sx, y0: a.content.y * sy, y1: (a.content.y + a.content.h) * sy }
    : { x0: imgW * 0.05, x1: imgW * 0.95, y0: imgH * 0.05, y1: imgH * 0.95 }
  let params = prev
  const base = prev as BoxLike

  // ---- Columns.
  const cands = a.vCandidates.map((x) => x * sx)
  const sides: Array<'left' | 'right'> =
    !lockLayout && arch.options.some((o) => o.key === 'glueSide') ? ['right', 'left'] : [arch.glueSide(prev)]
  let cols: ColumnGuess | null = null
  let side = arch.glueSide(prev)
  // Image evidence for a column strip: the flaps just above / below a real
  // panel (lid, dust flap, roof — or nothing) span it cleanly. A strip whose
  // flap band is half covered has a boundary in the wrong place (art edges can
  // mimic a repeating grid). Body fill is no evidence: pastel panels read as
  // background.
  const columnCost =
    mask && a.hBody
      ? (x0: number, x1: number) => {
          const top = a.hBody!.top * sy
          const bot = a.hBody!.bottom * sy
          const bp = bot - top
          const inset = (x1 - x0) * 0.08
          const up = coverage(mask, imgW, imgH, x0 + inset, top - bp * 0.06, x1 - inset, top - bp * 0.015)
          const dn = coverage(mask, imgW, imgH, x0 + inset, bot + bp * 0.015, x1 - inset, bot + bp * 0.06)
          return Math.min(up, 1 - up) + Math.min(dn, 1 - dn)
        }
      : undefined
  for (const s of sides) {
    const g = bestColumns(cands, box.x0, box.x1, s, lockLayout ? arch.wideFirst(prev) : undefined, columnCost)
    if (g && (!cols || g.cost < cols.cost)) {
      cols = g
      side = s
    }
  }
  // Detected lines beat even spacing unless they're clearly nonsense.
  if (cols && cols.cost < 2) {
    if (!lockLayout) params = arch.withOptions(params, { glueSide: side, order: cols.wideFirst ? 'front-first' : 'side-first' })
  } else {
    // Fallback: the archetype's own proportions spread across the drawing.
    const gx = arch.guides(params).x
    const lo = Math.min(...gx.map((q) => q.pos))
    const hi = Math.max(...gx.map((q) => q.pos))
    const at = (id: string) => box.x0 + ((gx.find((q) => q.id === id)!.pos - lo) / (hi - lo)) * (box.x1 - box.x0)
    cols = { lines: COLUMN_GUIDES.map(at), glue: at('glue'), cost: Infinity, wideFirst: arch.wideFirst(params) }
  }

  // ---- Body band.
  let body = a.hBody ? { top: a.hBody.top * sy, bottom: a.hBody.bottom * sy } : null
  if (!body) {
    const ch = box.y1 - box.y0
    body = { top: box.y0 + ch * 0.22, bottom: box.y1 - ch * 0.22 }
  }

  // ---- Rows: the archetype's proportions at the detected scale, outermost
  // rows snapped to the drawing's extent, inner ones to nearby detected lines.
  const k = base.height / (body.bottom - body.top) // provisional cm per px
  const xFlat: Record<string, number> = {}
  COLUMN_GUIDES.forEach((id, i) => (xFlat[id] = (cols!.lines[i] - cols!.lines[0]) * k))
  xFlat.glue = (cols.glue - cols.lines[0]) * k
  // Width/depth from the detected columns; every other length keeps the
  // archetype's proportions at this body height.
  const sized = arch.fromGuides({ x: xFlat, y: yFlatOf(arch, params, base.height) }, params).params as BoxLike
  const shaped = scaleParams(params, base.height / Math.max(1e-6, (params as BoxLike).height))
  const p0 = { ...(shaped as object), width: sized.width, depth: sized.depth, height: base.height }
  const yGuides = arch.guides(p0).y
  const toPx = (flatY: number) => body!.bottom - flatY / k
  const hC = a.hCandidates.map((y) => y * sy)
  const ys: Record<string, number> = {}
  const posMin = Math.min(...yGuides.map((q) => q.pos))
  const posMax = Math.max(...yGuides.map((q) => q.pos))
  for (const q of yGuides) {
    if (q.id === 'body0') ys[q.id] = body.bottom
    else if (q.id === 'bodyH') ys[q.id] = body.top
    else if (q.pos === posMax) ys[q.id] = box.y0
    else if (q.pos === posMin) ys[q.id] = box.y1
    else {
      const want = toPx(q.pos)
      const near = hC.filter((y) => Math.abs(y - want) < (box.y1 - box.y0) * 0.03)
      ys[q.id] = near.length ? near.reduce((m, y) => (Math.abs(y - want) < Math.abs(m - want) ? y : m)) : want
    }
  }
  const xs: Record<string, number> = { glue: cols.glue }
  COLUMN_GUIDES.forEach((id, i) => (xs[id] = cols!.lines[i]))
  const guides: ImageGuides = { x: xs, y: ys }

  // ---- Lids: which wide panel has something above / below the body.
  if (mask && !lockLayout && arch.options.some((o) => o.key === 'lidOn')) {
    const wideIdx = cols.wideFirst ? [0, 2] : [1, 3]
    const depthPx = sized.depth / k
    const cov = (i: number, y0: number, y1: number) => {
      const l = cols!.lines
      const inset = (l[i + 1] - l[i]) * 0.2
      return coverage(mask, imgW, imgH, l[i] + inset, y0, l[i + 1] - inset, y1)
    }
    const top = wideIdx.map((i) => cov(i, body!.top - depthPx * 0.7, body!.top - depthPx * 0.15))
    const bot = wideIdx.map((i) => cov(i, body!.bottom + depthPx * 0.15, body!.bottom + depthPx * 0.7))
    if (Math.abs(top[0] - top[1]) > 0.25 && Math.abs(bot[0] - bot[1]) > 0.25) {
      const topFirst = top[0] > top[1]
      const botFirst = bot[0] > bot[1]
      params = arch.withOptions(params, {
        lidOn: topFirst ? 'first' : 'second',
        style: topFirst === botFirst ? 'straight' : 'reverse',
      })
    }
  }

  return { guides, params: fitParams(arch, guides, base.height, params).params }
}

/**
 * A gable carton has a flap above EVERY body column (roofs + gussets); a
 * tuck box only above its lid panel and (short) dust flaps. Reads the band
 * just above the body top, given guides fitted as a tuck box.
 */
export function looksLikeGable(g: ImageGuides, mask: Uint8Array, w: number, h: number): boolean {
  const bodyPx = g.y.body0 - g.y.bodyH
  const cols = COLUMN_GUIDES.map((id) => g.x[id])
  let lowest = 1
  for (let i = 0; i < 4; i++) {
    const inset = (cols[i + 1] - cols[i]) * 0.2
    const band = coverage(mask, w, h, cols[i] + inset, g.y.bodyH - bodyPx * 0.12, cols[i + 1] - inset, g.y.bodyH - bodyPx * 0.03)
    lowest = Math.min(lowest, band)
  }
  return lowest > 0.6
}

/** The archetype's y-guides (flat) for `p` rescaled to body height `h`. */
function yFlatOf(arch: Archetype<unknown>, p: unknown, h: number): Record<string, number> {
  const scaled = scaleParams(p, h / Math.max(1e-6, (p as BoxLike).height))
  return Object.fromEntries(arch.guides(scaled).y.map((q) => [q.id, q.pos]))
}
