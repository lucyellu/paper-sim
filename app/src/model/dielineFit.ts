// Fit-the-grid math for the dieline-image wizard: guide lines live in IMAGE
// pixels (what the user drags); a real body height turns them into flat cm
// (uniform scale, anchored on guides c0 / body0), the archetype turns those
// into params, and the same mapping registers the image onto the built sheet
// as an OverlayTransform. Each face then gets its own registration (per-face
// UVs) read off the guides that bound it, so panels the picture draws at
// inconsistent sizes still carry their own art. Also: print-DPI / one-Letter-page sizing and the
// rules-based initial guess from the raster analyzer. Pure (no DOM).

import { ARCHETYPES, COLUMN_GUIDES, archetypeOptions, type Archetype, type ArchetypeId, type GuidePositions } from './archetypes'
import { sheetBounds, type Face, type PaperDoc, type Vec2 } from './document'
import { floodForeground, type DielineImageAnalysis } from './dielineImage'
import type { OverlayTransform } from './material'
import type { RGBAImage } from './photoUnwarp'
import { fitsOneLetterPage } from './printFit'
import { faceUVCentroid, pruneUVEdits, type UVEdits } from './uv'
import { resolveCross, type CrossParams } from './crossbox'

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
  /**
   * The crop was made by picking one drawing out of several: everything in it
   * except the biggest drawing (labels, crop marks, a neighbor's edge) is
   * painted over with the background.
   */
  isolate?: boolean
  /** The baked (rotated + flipped + cropped) picture every later step uses. */
  image: string
  imageW: number
  imageH: number
  archetype: ArchetypeId
  params: unknown
  guides: ImageGuides
  heightCm: number
  /** An end panel drawn folded away (guides above are as dragged). */
  folded?: FoldedAway
}

/**
 * An end panel the picture doesn't draw flat — mockups often show the last
 * panel and glue flap folded back in perspective. Its column is copied from
 * its twin (the panel two over) and its art is plain paper.
 */
export type FoldedAway = 'none' | 'first' | 'last'

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
  return overlayFromMap(doc, { xa: k, xb: -g.x.c0 * k, ya: -k, yb: g.y.body0 * k }, imgW, imgH)
}

// ---------------------------------------------------------------------------
// Per-face registration

/** Image px = a·flat + b, per axis (image y grows down, so ay < 0). */
export interface FaceImageMap {
  ax: number
  bx: number
  ay: number
  by: number
}

/** Piecewise-linear flat → image map through (flat, image) guide pairs; extrapolates the end segments. */
function piecewise(pairs: Array<[number, number]>): (v: number) => number {
  const pts = [...pairs].sort((a, b) => a[0] - b[0])
  if (pts.length === 1) return (v) => pts[0][1] + (v - pts[0][0])
  return (v) => {
    let i = 0
    while (i < pts.length - 2 && v > pts[i + 1][0]) i++
    const [f0, m0] = pts[i]
    const [f1, m1] = pts[i + 1]
    return m0 + ((v - f0) / (f1 - f0 || 1e-9)) * (m1 - m0)
  }
}

/**
 * Where each face's art sits in the picture: its flat bounding box mapped
 * through the guides in its scope (flat positions from the built params,
 * picture positions from the dragged guides). Faces between guides land
 * exactly on their panel in the picture however the panels disagree.
 */
export function faceImageMaps(arch: Archetype<unknown>, params: unknown, doc: PaperDoc, g: ImageGuides): Map<number, FaceImageMap> {
  const flat = arch.guides(params)
  const flatX = Object.fromEntries(flat.x.map((q) => [q.id, q.pos]))
  const flatY = Object.fromEntries(flat.y.map((q) => [q.id, q.pos]))
  const pos = new Map(doc.vertices.map((v) => [v.id, v.pos]))
  const out = new Map<number, FaceImageMap>()
  const cache = new Map<string, { fx: (v: number) => number; fy: (v: number) => number }>()
  for (const face of doc.faces) {
    const scope = arch.faceScope?.(face.name) ?? { x: Object.keys(flatX), y: Object.keys(flatY) }
    const key = scope.x.join() + '|' + scope.y.join()
    let fns = cache.get(key)
    if (!fns) {
      const px = scope.x.filter((id) => id in g.x && id in flatX).map((id) => [flatX[id], g.x[id]] as [number, number])
      const py = scope.y.filter((id) => id in g.y && id in flatY).map((id) => [flatY[id], g.y[id]] as [number, number])
      fns = { fx: piecewise(px), fy: piecewise(py) }
      cache.set(key, fns)
    }
    const xs = face.vertexIds.map((id) => pos.get(id)!.x)
    const ys = face.vertexIds.map((id) => pos.get(id)!.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const ax = (fns.fx(x1) - fns.fx(x0)) / Math.max(x1 - x0, 1e-9)
    const ay = (fns.fy(y1) - fns.fy(y0)) / Math.max(y1 - y0, 1e-9)
    out.set(face.id, { ax, bx: fns.fx(x0) - ax * x0, ay, by: fns.fy(y0) - ay * y0 })
  }
  return out
}

/** Image px → flat cm, per axis: X = xa·u + xb, Y = ya·v + yb (ya < 0: image y grows down). */
export interface ImageToFlat {
  xa: number
  xb: number
  ya: number
  yb: number
}

/** The OverlayTransform that places the picture by `m` on the doc's sheet. */
export function overlayFromMap(doc: PaperDoc, m: ImageToFlat, imgW: number, imgH: number): OverlayTransform {
  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 1e-6)
  const h = Math.max(max.y - min.y, 1e-6)
  // buildSheetCanvas draws the overlay rect in canvas space (row 0 = sheet max.y).
  return {
    offsetX: (m.xb - min.x) / w,
    offsetY: (max.y - m.yb) / h,
    scaleX: (m.xa * imgW) / w,
    scaleY: (-m.ya * imgH) / h,
    rotationDeg: 0,
  }
}

/**
 * Where the picture goes on the sheet before per-face registration. The
 * texture only holds what lands on the sheet, and each face can only pull
 * its art from there — so: the uniform fit (overlayForFit) when it keeps
 * every face's picture region on the sheet (a consistent picture then needs
 * no per-face edits), otherwise the picture's panel area stretched over the
 * whole sheet (panels drawn bigger than the averaged box stay reachable).
 */
export function fitPlacement(doc: PaperDoc, maps: Map<number, FaceImageMap>, g: ImageGuides, heightCm: number): ImageToFlat {
  const k = cmPerPx(g, heightCm)
  const uniform: ImageToFlat = { xa: k, xb: -g.x.c0 * k, ya: -k, yb: g.y.body0 * k }
  const { min, max } = sheetBounds(doc)
  const pos = new Map(doc.vertices.map((v) => [v.id, v.pos]))
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (const face of doc.faces) {
    const m = maps.get(face.id)
    if (!m) continue
    for (const id of face.vertexIds) {
      const p = pos.get(id)!
      const u = m.ax * p.x + m.bx
      const v = m.ay * p.y + m.by
      u0 = Math.min(u0, u)
      u1 = Math.max(u1, u)
      v0 = Math.min(v0, v)
      v1 = Math.max(v1, v)
    }
  }
  if (!Number.isFinite(u0)) return uniform
  const tol = 0.005 * Math.max(max.x - min.x, max.y - min.y)
  const on =
    uniform.xa * u0 + uniform.xb >= min.x - tol &&
    uniform.xa * u1 + uniform.xb <= max.x + tol &&
    uniform.ya * v1 + uniform.yb >= min.y - tol &&
    uniform.ya * v0 + uniform.yb <= max.y + tol
  if (on) return uniform
  const xa = (max.x - min.x) / Math.max(u1 - u0, 1e-6)
  const ya = -(max.y - min.y) / Math.max(v1 - v0, 1e-6)
  return { xa, xb: min.x - xa * u0, ya, yb: max.y - ya * v0 }
}

/**
 * Per-face UV edits that make each face sample its own picture region
 * (faceImageMaps) instead of where the placement `place` (fitPlacement)
 * puts it. Faces the placement already registers get no edit.
 */
export function faceRegistration(doc: PaperDoc, maps: Map<number, FaceImageMap>, place: ImageToFlat): UVEdits {
  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 1e-6)
  const h = Math.max(max.y - min.y, 1e-6)
  const edits: UVEdits = {}
  for (const face of doc.faces as Face[]) {
    const m = maps.get(face.id)
    if (!m) continue
    // Flat point p shows picture pixel (ax·p.x + bx, ay·p.y + by), which the
    // placement puts at flat (sx·p.x + tx, sy·p.y + ty).
    const sx = place.xa * m.ax
    const tx = place.xa * m.bx + place.xb
    const sy = place.ya * m.ay
    const ty = place.ya * m.by + place.yb
    // Already registered by the placement (to float noise): no edit.
    if (Math.abs(sx - 1) < 1e-4 && Math.abs(sy - 1) < 1e-4 && Math.abs(tx) < 1e-4 && Math.abs(ty) < 1e-4) continue
    const c = faceUVCentroid(doc, face)
    edits[face.id] = {
      du: (sx * min.x + tx - min.x) / w + (sx - 1) * c.u,
      dv: (sy * min.y + ty - min.y) / h + (sy - 1) * c.v,
      rotationDeg: 0,
      scaleU: sx,
      scaleV: sy,
    }
  }
  return pruneUVEdits(edits)
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
// Folded-away end panel

/**
 * The guides the box is fitted with when an end panel is folded away: its
 * column is as wide as its twin's and the glue flap on that end (if any) gets
 * a typical width. Other guides are unchanged. Needs column guides c0..c4.
 */
export function withFoldedAway(g: ImageGuides, folded: FoldedAway | undefined, glueSide: 'left' | 'right'): ImageGuides {
  if (!folded || folded === 'none' || g.x.c4 === undefined) return g
  const x = { ...g.x }
  if (folded === 'last') x.c4 = x.c3 + (x.c2 - x.c1)
  else x.c0 = x.c1 - (x.c3 - x.c2)
  const glue = 0.25 * ((x.c4 - x.c0) / 4)
  if ('glue' in x && folded === 'last' && glueSide === 'right') x.glue = x.c4 + glue
  if ('glue' in x && folded === 'first' && glueSide === 'left') x.glue = x.c0 - glue
  return { ...g, x }
}

/**
 * The picture's strip (image px, x range) that holds no flat art when an end
 * panel is folded away — everything past the last drawn column line.
 */
export function foldedStrip(g: ImageGuides, folded: FoldedAway | undefined): { x0: number; x1: number } | null {
  if (!folded || folded === 'none' || g.x.c4 === undefined) return null
  return folded === 'last' ? { x0: g.x.c3, x1: Infinity } : { x0: -Infinity, x1: g.x.c1 }
}

/**
 * Guess whether an end panel is drawn folded away: its column is much
 * narrower than its twin's and has no flap at either end (a flat end panel
 * has a lid or dust flaps).
 */
export function guessFoldedAway(g: ImageGuides, mask: Uint8Array, w: number, h: number): FoldedAway {
  if (g.x.c4 === undefined) return 'none'
  const c = COLUMN_GUIDES.map((id) => g.x[id])
  const cols = [0, 1, 2, 3].map((i) => c[i + 1] - c[i])
  const bodyPx = g.y.body0 - g.y.bodyH
  const flapped = (i: number) => {
    const inset = cols[i] * 0.2
    const up = coverage(mask, w, h, c[i] + inset, g.y.bodyH - bodyPx * 0.12, c[i + 1] - inset, g.y.bodyH - bodyPx * 0.03)
    const dn = coverage(mask, w, h, c[i] + inset, g.y.body0 + bodyPx * 0.03, c[i + 1] - inset, g.y.body0 + bodyPx * 0.12)
    return Math.max(up, dn) > 0.25
  }
  if (cols[3] < cols[1] * 0.7 && !flapped(3)) return 'last'
  if (cols[0] < cols[2] * 0.7 && !flapped(0)) return 'first'
  return 'none'
}

// ---------------------------------------------------------------------------
// Initial guess

/**
 * Foreground = the drawing: the background is flooded in from the border (see
 * floodForeground), so vignettes stay background and flaps drawn only as an
 * outline on the background count as drawing. `threshold` is the color
 * distance from the border median that is always background — sensitive on
 * purpose: pastel flaps on cream paper differ by ~35.
 */
export function foregroundMask(img: RGBAImage, threshold = 24): Uint8Array {
  return floodForeground(img.data, img.width, img.height, { tol: threshold })
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
 * `pixels` (RGBA, imgW × imgH) lets the cross box read its crease lines.
 */
export function initialFit(
  archId: ArchetypeId,
  prev: unknown,
  a: DielineImageAnalysis,
  imgW: number,
  imgH: number,
  mask?: Uint8Array,
  lockLayout = false,
  pixels?: Uint8ClampedArray,
): { guides: ImageGuides; params: unknown } {
  const arch = ARCHETYPES[archId]
  if (archId === 'cross') {
    const guides = crossGuides(prev as CrossParams, imgW, imgH, mask, pixels)
    return { guides, params: fitParams(arch, guides, (prev as BoxLike).height, prev).params }
  }
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
    !lockLayout && archetypeOptions(arch, prev).some((o) => o.key === 'glueSide') ? ['right', 'left'] : [arch.glueSide(prev)]
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
  // A tuck box's body is the band where the drawing spans its full width; the
  // rows above and below hold only the lid and dust flaps, with gaps between.
  // The strongest edges can sit at a flap's tip instead (a dust flap's top edge
  // across a plain panel), so a body edge in rows that aren't full width moves
  // in to the band's edge — onto a detected line there, if one is close.
  if (mask && archId === 'tuck') {
    const band = fullWidthBand(mask, imgW, imgH, box)
    const ch = box.y1 - box.y0
    const snap = (y: number) => {
      const near = a.hCandidates.map((c) => c * sy).filter((c) => Math.abs(c - y) < ch * 0.015)
      return near.length ? near.reduce((m, c) => (Math.abs(c - y) < Math.abs(m - y) ? c : m)) : y
    }
    if (band && band.bottom - band.top >= ch * 0.35) {
      if (band.top - body.top > ch * 0.02) body.top = snap(band.top)
      if (body.bottom - band.bottom > ch * 0.02) body.bottom = snap(band.bottom)
    }
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

  // ---- Lids. Each end of a tuck box has the lid on one panel, a dust flap
  // on each neighbour and nothing on the panel opposite, so an end whose one
  // bare panel faces a flap names its lid column. Failing that, a flap clearly
  // longer than the rest is the lid. An end that stays ambiguous (a bare
  // panel on both sides, e.g. the last panel drawn folded away) follows the
  // other end: straight if the lid panel has a flap there too, else reverse.
  // The lid panels are the builder's "wide" panels, so this also settles the
  // panel order.
  if (mask && !lockLayout && archetypeOptions(arch, params).some((o) => o.key === 'topLid')) {
    const l = cols.lines
    const colW = [0, 1, 2, 3].map((i) => l[i + 1] - l[i])
    const meanW = (l[4] - l[0]) / 4
    const bodyPx = body.bottom - body.top
    /** How far column i's flap reaches past the body edge (dir −1 = up), px. */
    const flapLen = (i: number, dir: -1 | 1) => {
      const inset = colW[i] * 0.2
      const edge = dir < 0 ? body!.top : body!.bottom
      const step = Math.max(2, bodyPx * 0.01)
      const room = dir < 0 ? edge : imgH - edge
      let reach = 0
      let miss = 0
      for (let d = step; d < room; d += step) {
        const y = edge + dir * d
        if (coverage(mask, imgW, imgH, l[i] + inset, y, l[i + 1] - inset, y + dir * step) >= 0.4) {
          reach = d + step
          miss = 0
        } else if (++miss > 2) break
      }
      return reach
    }
    const endLid = (len: number[]): { col: number; cands: number[] } => {
      const bare = len.map((v) => v < meanW * 0.12)
      const cands = [0, 1, 2, 3].filter((i) => bare[(i + 2) % 4])
      const flapped = cands.filter((i) => !bare[i])
      if (flapped.length === 1) return { col: flapped[0], cands }
      const pool = flapped.length ? flapped : [0, 1, 2, 3]
      const byLen = [...pool].sort((x, y) => len[y] - len[x])
      const clear = byLen.length === 1 || len[byLen[0]] >= 1.3 * len[byLen[1]]
      return { col: clear && len[byLen[0]] > 0 ? byLen[0] : -1, cands }
    }
    const topLen = [0, 1, 2, 3].map((i) => flapLen(i, -1))
    const botLen = [0, 1, 2, 3].map((i) => flapLen(i, 1))
    const t = endLid(topLen)
    const b = endLid(botLen)
    /** The other end's lid, given this end's lid column and the other end's flaps. */
    const follow = (col: number, other: { cands: number[] }, otherLen: number[]) => {
      const straight = otherLen[col] >= meanW * 0.12
      const pick = straight ? col : (col + 2) % 4
      return other.cands.length && !other.cands.includes(pick) && other.cands.includes((pick + 2) % 4) ? (pick + 2) % 4 : pick
    }
    let lids: { top: number; bottom: number } | null = null
    if (t.col >= 0 && b.col >= 0 && t.col % 2 === b.col % 2) lids = { top: t.col, bottom: b.col }
    else if (t.col >= 0) lids = { top: t.col, bottom: follow(t.col, b, botLen) }
    else if (b.col >= 0) lids = { top: follow(b.col, t, topLen), bottom: b.col }
    if (lids) {
      params = arch.withOptions(params, {
        topLid: String(lids.top + 1),
        style: lids.top === lids.bottom ? 'straight' : 'reverse',
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

/**
 * The run of rows around the widest one where the drawing covers ≥ 90% of
 * that width inside `box` (a tapered glue flap costs a few %), or null.
 */
function fullWidthBand(
  mask: Uint8Array,
  w: number,
  h: number,
  box: { x0: number; x1: number; y0: number; y1: number },
): { top: number; bottom: number } | null {
  const xa = Math.max(0, Math.round(box.x0))
  const xb = Math.min(w, Math.round(box.x1) + 1)
  const ya = Math.max(0, Math.round(box.y0))
  const yb = Math.min(h - 1, Math.round(box.y1))
  if (xb <= xa || yb <= ya) return null
  const cov = new Int32Array(h)
  let peak = ya
  for (let y = ya; y <= yb; y++) {
    let n = 0
    for (let x = xa; x < xb; x++) n += mask[y * w + x]
    cov[y] = n
    if (n > cov[peak]) peak = y
  }
  const t = cov[peak] * 0.9
  let top = peak
  let bottom = peak
  while (top > ya && cov[top - 1] >= t) top--
  while (bottom < yb && cov[bottom + 1] >= t) bottom++
  return { top, bottom }
}

/** The archetype's y-guides (flat) for `p` rescaled to body height `h`. */
function yFlatOf(arch: Archetype<unknown>, p: unknown, h: number): Record<string, number> {
  const scaled = scaleParams(p, h / Math.max(1e-6, (p as BoxLike).height))
  return Object.fromEntries(arch.guides(scaled).y.map((q) => [q.id, q.pos]))
}

// ---------------------------------------------------------------------------
// Cross box (cube net): a tall center strip with a side wall hanging off each
// edge of the front.

interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

function maskBox(mask: Uint8Array, w: number, h: number): Box | null {
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 }
}

/** Per-column foreground counts and the center strip (the tallest run of columns). */
function centerStrip(mask: Uint8Array, w: number, h: number) {
  const col = new Int32Array(w)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[x] += mask[y * w + x]
  let top = 0
  for (let x = 1; x < w; x++) if (col[x] > col[top]) top = x
  const t = col[top] * 0.75
  let c0 = top
  let c1 = top
  while (c0 > 0 && col[c0 - 1] >= t) c0--
  while (c1 < w - 1 && col[c1 + 1] >= t) c1++
  return { col, c0, c1: c1 + 1, tall: col[top] }
}

/**
 * A cube-net cross: one run of columns spans (nearly) the whole drawing's
 * height, with wings of similar width on both sides that are much shorter.
 * (A straight tuck box's full-height lid column has the long body on one
 * side and only the glue flap or a narrow panel on the other.)
 */
export function looksLikeCross(mask: Uint8Array, w: number, h: number): boolean {
  const box = maskBox(mask, w, h)
  if (!box) return false
  const { col, c0, c1, tall } = centerStrip(mask, w, h)
  const span = box.x1 - box.x0
  const left = c0 - box.x0
  const right = box.x1 - c1
  if (tall < (box.y1 - box.y0) * 0.85 || left < span * 0.2 || right < span * 0.2) return false
  if (Math.abs(left - right) / Math.max(left, right) > 0.35) return false
  // Wing height, skipping the anti-aliased columns right at the strip's edges.
  let wing = 0
  for (let x = box.x0; x < c0 - left * 0.05; x++) wing = Math.max(wing, col[x])
  for (let x = Math.ceil(c1 + right * 0.05); x <= box.x1; x++) wing = Math.max(wing, col[x])
  return wing < tall * 0.6
}

/** Local maxima of `score` in [a, b] at least `minSep` apart, strongest first. */
function linePeaks(score: Float32Array, a: number, b: number, minSep: number, min: number): Array<{ y: number; s: number }> {
  const raw: Array<{ y: number; s: number }> = []
  for (let y = Math.max(1, a); y <= Math.min(score.length - 2, b); y++) {
    if (score[y] >= min && score[y] >= score[y - 1] && score[y] >= score[y + 1]) raw.push({ y, s: score[y] })
  }
  raw.sort((p, q) => q.s - p.s)
  const kept: Array<{ y: number; s: number }> = []
  for (const p of raw) if (kept.every((k) => Math.abs(k.y - p.y) >= minSep)) kept.push(p)
  return kept
}

/**
 * Initial guides for the cross box. Columns and outer extents come from the
 * foreground mask; crease rows are the rows where a luminance edge runs across
 * most of the panel's width (dashed creases and color changes do, artwork
 * mostly doesn't). Without pixels, proportional fallbacks.
 */
function crossGuides(p: CrossParams, w: number, h: number, mask?: Uint8Array, pixels?: Uint8ClampedArray): ImageGuides {
  const m = mask ?? new Uint8Array(w * h).fill(1)
  const box = maskBox(m, w, h) ?? { x0: 0, x1: w - 1, y0: 0, y1: h - 1 }
  let { c0, c1 } = centerStrip(m, w, h)
  if (!mask || c1 - c0 < (box.x1 - box.x0) * 0.1) {
    // No usable mask: the default proportions across the drawing.
    const r = resolveCross(p)
    const tot = r.W + 2 * (r.D + r.FLAP)
    c0 = box.x0 + ((r.D + r.FLAP) / tot) * (box.x1 - box.x0)
    c1 = box.x1 - ((r.D + r.FLAP) / tot) * (box.x1 - box.x0)
  }
  const lum = new Float32Array(w * h)
  if (pixels) {
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]
  }
  const T = 10
  const on = (x: number, y: number) => m[y * w + x] === 1

  /** Fraction of columns [xa, xb) drawn in row y. */
  const rowIn = (y: number, xa: number, xb: number) => {
    const a = Math.round(xa)
    const b = Math.round(xb)
    let n = 0
    for (let x = a; x < b; x++) n += m[y * w + x]
    return n / Math.max(1, b - a)
  }
  // Strip extent: rows where most of the strip is drawn.
  let sy0 = box.y0
  let sy1 = box.y1
  while (sy0 < sy1 && rowIn(sy0, c0, c1) < 0.5) sy0++
  while (sy1 > sy0 && rowIn(sy1, c0, c1) < 0.5) sy1--
  const L = sy1 - sy0
  // Side extent (dust flap tops / bottoms): rows where either wing is drawn.
  let ys0 = -1
  let ys1 = -1
  for (let y = box.y0; y <= box.y1; y++) {
    if (Math.max(rowIn(y, box.x0, c0), rowIn(y, c1, box.x1 + 1)) >= 0.15) {
      if (ys0 < 0) ys0 = y
      ys1 = y
    }
  }
  if (ys0 < 0) {
    ys0 = sy0 + L * 0.3
    ys1 = sy0 + L * 0.6
  }
  const Hs = ys1 - ys0

  /** Per row: fraction of the given columns with a vertical luminance edge. */
  const rowScore = (ranges: Array<[number, number]>) => {
    const sc = new Float32Array(h)
    if (!pixels) return sc
    for (let y = 1; y < h - 1; y++) {
      let n = 0
      let e = 0
      for (const [xa, xb] of ranges) {
        for (let x = Math.round(xa); x < Math.round(xb); x++) {
          if (!on(x, y - 1) || !on(x, y + 1)) continue
          n++
          if (Math.abs(lum[(y + 1) * w + x] - lum[(y - 1) * w + x]) > T) e++
        }
      }
      sc[y] = n ? e / n : 0
    }
    // A 2-px-wide line reads as one peak.
    const out = new Float32Array(h)
    for (let y = 1; y < h - 1; y++) out[y] = Math.max(sc[y - 1], sc[y], sc[y + 1])
    return out
  }
  /** Per column in [xa, xb): fraction of rows [ya, yb) with a horizontal luminance edge. */
  const colScore = (xa: number, xb: number, ya: number, yb: number) => {
    const sc = new Float32Array(w)
    if (!pixels) return sc
    for (let x = Math.max(1, Math.round(xa)); x < Math.min(w - 1, Math.round(xb)); x++) {
      let n = 0
      let e = 0
      for (let y = Math.round(ya); y < Math.round(yb); y++) {
        if (!on(x - 1, y) || !on(x + 1, y)) continue
        n++
        if (Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]) > T) e++
      }
      sc[x] = n ? e / n : 0
    }
    const out = new Float32Array(w)
    for (let x = 1; x < w - 1; x++) out[x] = Math.max(sc[x - 1], sc[x], sc[x + 1])
    return out
  }
  /** The strongest line in [a, b] — or, given `near`, the nearest of the strong ones. */
  const pick = (sc: Float32Array, a: number, b: number, fallback: number, near?: number) => {
    const pk = linePeaks(sc, Math.round(Math.min(a, b)), Math.round(Math.max(a, b)), Math.max(3, L * 0.01), 0.35)
    if (!pk.length) return fallback
    if (near === undefined) return pk[0].y
    const strong = pk.filter((q) => q.s >= pk[0].s * 0.7)
    return strong.reduce((m2, q) => (Math.abs(q.y - near) < Math.abs(m2.y - near) ? q : m2)).y
  }

  // Side walls vs their outer flaps: a vertical line across the side's middle.
  const ya = ys0 + Hs * 0.35
  const yb = ys0 + Hs * 0.65
  const leftW = c0 - box.x0
  const rightW = box.x1 - c1
  const sideL = pick(colScore(box.x0, c0, ya, yb), box.x0 + leftW * 0.03, box.x0 + leftW * 0.5, box.x0 + leftW * 0.18)
  const sideR = pick(colScore(c1, box.x1, ya, yb), box.x1 - rightW * 0.5, box.x1 - rightW * 0.03, box.x1 - rightW * 0.18)

  // The side walls' top / bottom creases, between their dust flaps.
  const sideRows = rowScore([
    [sideL + (c0 - sideL) * 0.15, c0 - (c0 - sideL) * 0.15],
    [c1 + (sideR - c1) * 0.15, sideR - (sideR - c1) * 0.15],
  ])
  const sideTop = pick(sideRows, ys0 + Hs * 0.05, ys0 + Hs * 0.45, ys0 + Hs * 0.2)
  const sideBot = pick(sideRows, ys0 + Hs * 0.55, ys1 - Hs * 0.05, ys1 - Hs * 0.2)
  const sideMid = (sideTop + sideBot) / 2

  // Center strip creases. The front is the panel the sides hang off, so its
  // edges are the strong lines nearest the sides' top / bottom.
  const inset = (c1 - c0) * 0.06
  const rows = rowScore([[c0 + inset, c1 - inset]])
  const lid = pick(rows, sy0 + L * 0.01, sy0 + L * 0.15, sy0 + L * 0.06)
  const back = pick(rows, sy1 - L * 0.15, sy1 - L * 0.01, sy1 - L * 0.06)
  const bodyH = pick(rows, lid + L * 0.03, sideMid - L * 0.05, Math.min(sideTop, sideMid - L * 0.1), sideTop)
  const body0 = pick(rows, sideMid + L * 0.05, back - L * 0.1, Math.max(sideBot, sideMid + L * 0.1), sideBot)
  const bottom = pick(rows, body0 + L * 0.05, back - L * 0.05, (body0 + back) / 2)

  return {
    x: { flapL: box.x0, sideL, c0, c1, sideR, flapR: box.x1 + 1 },
    y: {
      topTuck: sy0,
      lid,
      bodyH,
      body0,
      bottom,
      back,
      backTab: sy1 + 1,
      sideDustTop: ys0,
      sideTop,
      sideBot,
      sideDustBot: ys1 + 1,
    },
  }
}
