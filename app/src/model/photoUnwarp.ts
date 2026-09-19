// Photo → carton artwork. Given a 3/4-view picture of a gable-top carton and a
// handful of clicked corners, unwarp each visible face (4-point homography,
// bilinear sampling) into its flat panel rect on the gable dieline, fill the
// hidden/unseen panels (ribs, flaps, glue, outer gusset triangles) with
// sampled colors, and bleed everything ~2 mm past the cut lines. The result is
// one RGBA image covering sheetBounds(buildGableCarton(dims)) exactly — the
// material overlay stretches it across the sheet 1:1. Geometry never comes
// from the photo: the carton is always the parametric gable builder's.
//
// Pure math on plain RGBA buffers (no DOM), so it is testable anywhere.

import { bleedPixels } from './bleed'
import { resolveDims, type GableDims } from './gable'
import { LETTER_LANDSCAPE, fitsOneLetterPage } from './printFit'

export interface Pt {
  x: number
  y: number
}

export interface RGBAImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Which of the two visible faces in the photo is the carton's FRONT. */
export type FrontSide = 'left' | 'right'

/** Quad corners in visual order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt]

/**
 * The guided clicks, in order (image pixel coords). 0–5 are the body "Y":
 * the three bottom corners left→right, then the same three at the top of the
 * body. 6–7 are the ridge ends above the front roof (left, right in the
 * image). An optional 9th point is the gusset apex on the side face.
 */
export const POINT_PROMPTS = [
  'Bottom-left corner of the LEFT face',
  'Shared bottom corner (where the two faces meet)',
  'Bottom-right corner of the RIGHT face',
  'Top-left of the LEFT face body (where the roof / gable starts)',
  'Shared top corner (top of the middle edge)',
  'Top-right of the RIGHT face body',
  'Left end of the roof ridge (top edge of the front roof slope, just under the seal)',
  'Right end of the roof ridge',
] as const

export const REQUIRED_POINTS = 8

// ---------------------------------------------------------------------------
// Homography

/**
 * 3×3 homography (row-major, h[8] = 1) mapping each src[i] to dst[i]. Solves
 * the standard 8×8 DLT system by Gaussian elimination with partial pivoting.
 */
export function solveHomography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  const n = 8
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    if (Math.abs(A[piv][c]) < 1e-12) throw new Error('degenerate quad')
    ;[A[c], A[piv]] = [A[piv], A[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      if (f === 0) continue
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]
    }
  }
  const h = A.map((row, i) => row[n] / row[i])
  h.push(1)
  return h
}

export function applyHomography(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

// ---------------------------------------------------------------------------
// Pixel helpers

export function createImage(width: number, height: number, fill: RGB = [255, 255, 255]): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]
    data[i + 1] = fill[1]
    data[i + 2] = fill[2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

export type RGB = [number, number, number]

/** Bilinear sample of `img` at (x, y) (pixel-center convention), edge-clamped. */
function sampleInto(img: RGBAImage, x: number, y: number, out: Uint8ClampedArray, o: number) {
  const fx = Math.min(Math.max(x - 0.5, 0), img.width - 1)
  const fy = Math.min(Math.max(y - 0.5, 0), img.height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, img.width - 1)
  const y1 = Math.min(y0 + 1, img.height - 1)
  const tx = fx - x0
  const ty = fy - y0
  const d = img.data
  const i00 = (y0 * img.width + x0) * 4
  const i10 = (y0 * img.width + x1) * 4
  const i01 = (y1 * img.width + x0) * 4
  const i11 = (y1 * img.width + x1) * 4
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * tx
    const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * tx
    out[o + c] = top + (bot - top) * ty
  }
  out[o + 3] = 255
}

/** Integer pixel span [a, b) covering pixel centers inside the float span. */
function span(a: number, b: number, max: number): [number, number] {
  return [Math.max(0, Math.round(a)), Math.min(max, Math.round(b))]
}

export interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Fill `rect` of `dst` with the photo region inside `quad` (TL, TR, BR, BL in
 * image coords), perspective-correct. Marks painted pixels in `mask`.
 */
export function warpQuadInto(
  dst: RGBAImage,
  mask: Uint8Array,
  rect: PxRect,
  src: RGBAImage,
  quad: Quad,
) {
  const H = solveHomography(
    [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ],
    quad,
  )
  const [x0, x1] = span(rect.x, rect.x + rect.w, dst.width)
  const [y0, y1] = span(rect.y, rect.y + rect.h, dst.height)
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const q = applyHomography(H, { x: i + 0.5, y: j + 0.5 })
      const k = j * dst.width + i
      sampleInto(src, q.x, q.y, dst.data, k * 4)
      mask[k] = 1
    }
  }
}

/** Affine-warp the photo triangle `srcTri` onto the sheet triangle `dstTri`. */
export function warpTriangleInto(
  dst: RGBAImage,
  mask: Uint8Array,
  dstTri: [Pt, Pt, Pt],
  src: RGBAImage,
  srcTri: [Pt, Pt, Pt],
) {
  const [a, b, c] = dstTri
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
  if (Math.abs(det) < 1e-9) return
  const [x0, x1] = span(Math.min(a.x, b.x, c.x) - 1, Math.max(a.x, b.x, c.x) + 1, dst.width)
  const [y0, y1] = span(Math.min(a.y, b.y, c.y) - 1, Math.max(a.y, b.y, c.y) + 1, dst.height)
  // ~1 px of tolerance so the triangle's crease edges don't leave seams.
  const eps = 1 / Math.max(Math.abs(b.x - a.x), Math.abs(c.y - a.y), 1)
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const px = i + 0.5
      const py = j + 0.5
      const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / det
      const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / det
      const l3 = 1 - l1 - l2
      if (l1 < -eps || l2 < -eps || l3 < -eps) continue
      const sx = l1 * srcTri[0].x + l2 * srcTri[1].x + l3 * srcTri[2].x
      const sy = l1 * srcTri[0].y + l2 * srcTri[1].y + l3 * srcTri[2].y
      const k = j * dst.width + i
      sampleInto(src, sx, sy, dst.data, k * 4)
      mask[k] = 1
    }
  }
}

export function fillRect(dst: RGBAImage, mask: Uint8Array, rect: PxRect, color: RGB) {
  const [x0, x1] = span(rect.x, rect.x + rect.w, dst.width)
  const [y0, y1] = span(rect.y, rect.y + rect.h, dst.height)
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const k = j * dst.width + i
      dst.data[k * 4] = color[0]
      dst.data[k * 4 + 1] = color[1]
      dst.data[k * 4 + 2] = color[2]
      dst.data[k * 4 + 3] = 255
      mask[k] = 1
    }
  }
}

/** Per-channel median of the pixels on the rect's border ring (2 px inset). */
export function medianBorderColor(img: RGBAImage, rect: PxRect): RGB {
  const [x0, x1] = span(rect.x + 2, rect.x + rect.w - 2, img.width)
  const [y0, y1] = span(rect.y + 2, rect.y + rect.h - 2, img.height)
  const ch: number[][] = [[], [], []]
  const push = (i: number, j: number) => {
    const k = (j * img.width + i) * 4
    for (let c = 0; c < 3; c++) ch[c].push(img.data[k + c])
  }
  for (let i = x0; i < x1; i++) {
    push(i, y0)
    push(i, y1 - 1)
  }
  for (let j = y0; j < y1; j++) {
    push(x0, j)
    push(x1 - 1, j)
  }
  if (ch[0].length === 0) return [255, 255, 255]
  return ch.map((v) => {
    v.sort((p, q) => p - q)
    return v[v.length >> 1]
  }) as RGB
}

/** Grow painted pixels outward by `radius` px into unpainted ones (print bleed). */
export function bleed(img: RGBAImage, mask: Uint8Array, radius: number) {
  mask.set(bleedPixels(img.data, img.width, img.height, mask, radius))
}

// ---------------------------------------------------------------------------
// Clicks → faces

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** The two body faces as quads (TL, TR, BR, BL), from the 6 "Y" clicks. */
function bodyQuads(p: Pt[]): { left: Quad; right: Quad } {
  return {
    left: [p[3], p[4], p[1], p[0]],
    right: [p[4], p[5], p[2], p[1]],
  }
}

function quadWidth(q: Quad): number {
  return (dist(q[0], q[1]) + dist(q[3], q[2])) / 2
}

function quadHeight(q: Quad): number {
  return (dist(q[0], q[3]) + dist(q[1], q[2])) / 2
}

/** The wider visible face — the default guess for the FRONT. */
export function widerFace(p: Pt[]): FrontSide {
  if (p.length < 6) return 'right'
  const { left, right } = bodyQuads(p)
  return quadWidth(right) >= quadWidth(left) ? 'right' : 'left'
}

/**
 * Default gusset apex: the ridge end over the side face. The ridge runs
 * along the width at mid-depth, so seen from outside, the side gable's peak
 * sits straight above the side's top midpoint at ridge height — exactly the
 * ridge end on that side (the recessed center triangle's apex hides behind it).
 */
export function defaultApex(p: Pt[], front: FrontSide): Pt {
  const [r0, r1] = p[6].x <= p[7].x ? [p[6], p[7]] : [p[7], p[6]]
  return front === 'right' ? r0 : r1
}

export interface PhotoFaces {
  front: Quad
  side: Quad
  /** Front roof slope: the front's body-top edge and the two ridge ends above it. */
  roof: { bodyTopL: Pt; bodyTopR: Pt; ridgeL: Pt; ridgeR: Pt }
  /** Side gable: side body-top-left, body-top-right, apex. */
  gusset: [Pt, Pt, Pt]
}

/** Front and side body quads — needs only the 6 "Y" clicks. */
export function bodyFaces(p: Pt[], front: FrontSide): { front: Quad; side: Quad } {
  const { left, right } = bodyQuads(p)
  return front === 'right' ? { front: right, side: left } : { front: left, side: right }
}

/** Every face the artwork is sampled from — needs all 8 clicks. */
export function photoFaces(p: Pt[], front: FrontSide, apex?: Pt): PhotoFaces {
  const { front: f, side: s } = bodyFaces(p, front)
  const [ridgeL, ridgeR] = p[6].x <= p[7].x ? [p[6], p[7]] : [p[7], p[6]]
  return {
    front: f,
    side: s,
    roof: { bodyTopL: f[0], bodyTopR: f[1], ridgeL, ridgeR },
    gusset: [s[0], s[1], apex ?? defaultApex(p, front)],
  }
}

/** Shrink a polygon toward its centroid by `t` (fraction) — trims dark silhouette outlines. */
function inset<T extends Pt[]>(pts: T, t: number): T {
  const c = pts.reduce((a, q) => ({ x: a.x + q.x / pts.length, y: a.y + q.y / pts.length }), { x: 0, y: 0 })
  return pts.map((q) => ({ x: q.x + (c.x - q.x) * t, y: q.y + (c.y - q.y) * t })) as T
}

// ---------------------------------------------------------------------------
// Dimensions

export interface PhotoProportions {
  /** Front width / body height. */
  wOverH: number
  /** Side (depth) width / front width. */
  dOverW: number
}

/**
 * Carton proportions straight from the click distances (foreshortening is
 * ignored on purpose — the flat art then matches what the photo shows).
 */
export function photoProportions(p: Pt[], front: FrontSide): PhotoProportions {
  const { front: f, side: s } = bodyFaces(p, front)
  const fw = quadWidth(f)
  const fh = quadHeight(f)
  return { wOverH: fw / Math.max(fh, 1e-6), dOverW: quadWidth(s) / Math.max(fw, 1e-6) }
}

/** Full gable dims from width/depth/height with the builder's defaults spelled out. */
export function cartonDims(width: number, depth: number, height: number): GableDims {
  return {
    width,
    depth,
    height,
    gable: Math.max(depth * 0.75, depth * 0.51 * 1.02),
    rib: 0.9,
    // Front/back bottom flaps fold across the depth — keep them from poking out the far side.
    botFB: Math.min(2.2, depth * 0.9),
    botLR: 1.8,
    glue: 1.2,
  }
}

export function dimsFromProportions(pr: PhotoProportions, height: number): GableDims {
  const width = pr.wOverH * height
  return cartonDims(width, pr.dOverW * width, height)
}

/** Flat sheet size (cm) of the gable dieline at these dims. */
export function sheetSizeCm(dims: GableDims): { w: number; h: number } {
  const d = resolveDims(dims)
  return { w: 2 * d.W + 2 * d.D + d.GLUE, h: Math.max(d.BOT_FB, d.BOT_LR) + d.H + d.G + d.R }
}

/** True when the true-scale PDF fits on ONE Letter page (either orientation). */
export function fitsLetter(dims: GableDims): boolean {
  const s = sheetSizeCm(dims)
  return fitsOneLetterPage(s.w, s.h)
}

/** The largest carton at these proportions that prints on one landscape Letter page. */
export function fitLetterDims(pr: PhotoProportions): GableDims {
  let lo = 1
  let hi = 60
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2
    const s = sheetSizeCm(dimsFromProportions(pr, m))
    if (s.w <= LETTER_LANDSCAPE.w - 0.2 && s.h <= LETTER_LANDSCAPE.h - 0.2) lo = m
    else hi = m
  }
  return dimsFromProportions(pr, Math.floor(lo * 10) / 10)
}

// ---------------------------------------------------------------------------
// Compositing

export interface CartonArt {
  image: RGBAImage
  /** Dominant roof color (fills ribs + outer gusset triangles). */
  roofColor: RGB
}

/**
 * Compose the full-sheet artwork for buildGableCarton(dims): one image whose
 * pixel (0,0) is the sheet's top-left (min.x, max.y) — canvas rows run
 * top-down while sheet y runs up, matching buildSheetCanvas's UV mapping.
 */
export function composeCartonArt(
  src: RGBAImage,
  points: Pt[],
  front: FrontSide,
  dims: GableDims,
  opts: { pxPerCm?: number; apex?: Pt; bleedCm?: number; insetFrac?: number } = {},
): CartonArt {
  const pxPerCm = opts.pxPerCm ?? 60
  const d = resolveDims(dims)
  const { W, D, H, G, R, BOT_FB, BOT_LR, GLUE } = d
  const minX = 0
  const maxX = 2 * W + 2 * D + GLUE
  const minY = -Math.max(BOT_FB, BOT_LR)
  const maxY = H + G + R
  const width = Math.max(8, Math.round((maxX - minX) * pxPerCm))
  const height = Math.max(8, Math.round((maxY - minY) * pxPerCm))
  const sx = width / (maxX - minX)
  const sy = height / (maxY - minY)
  const px = (x: number) => (x - minX) * sx
  const py = (y: number) => (maxY - y) * sy
  /** Sheet rect [x0,x1]×[y0,y1] (cm, y up) → pixel rect. */
  const rect = (x0: number, x1: number, y0: number, y1: number): PxRect => ({
    x: px(x0),
    y: py(y1),
    w: px(x1) - px(x0),
    h: py(y0) - py(y1),
  })

  const img = createImage(width, height)
  const mask = new Uint8Array(width * height)
  const faces = photoFaces(points, front, opts.apex)
  const t = opts.insetFrac ?? 0.012
  const frontQ = inset(faces.front, t)
  const sideQ = inset(faces.side, t)
  const { bodyTopL, bodyTopR, ridgeL, ridgeR } = faces.roof
  // Flat roof: its top edge (y = H+G) is the ridge, bottom edge (y = H) the body top.
  const roofQ = inset([ridgeL, ridgeR, bodyTopR, bodyTopL] as Quad, t)
  const gusTri = inset(faces.gusset, t)

  const colX = [0, W, W + D, 2 * W + D]
  const colW = [W, D, W, D]

  // Front/back columns: roof + body from the front face.
  for (const i of [0, 2]) {
    warpQuadInto(img, mask, rect(colX[i], colX[i] + W, H, H + G), src, roofQ)
    warpQuadInto(img, mask, rect(colX[i], colX[i] + W, 0, H), src, frontQ)
  }
  const roofColor = medianBorderColor(img, rect(0, W, H, H + G))

  // Side columns: body from the side face; gusset = roof color with the
  // photo's side gable in the center (recessed) triangle.
  for (const i of [1, 3]) {
    const x0 = colX[i]
    warpQuadInto(img, mask, rect(x0, x0 + D, 0, H), src, sideQ)
    fillRect(img, mask, rect(x0, x0 + D, H, H + G), roofColor)
    warpTriangleInto(
      img,
      mask,
      [
        { x: px(x0), y: py(H) },
        { x: px(x0 + D), y: py(H) },
        { x: px(x0 + D / 2), y: py(H + G) },
      ],
      src,
      gusTri,
    )
  }

  // Ribs (all four columns): roof color.
  for (let i = 0; i < 4; i++) fillRect(img, mask, rect(colX[i], colX[i] + colW[i], H + G, H + G + R), roofColor)

  // Bottom flaps + glue flap: solid, the adjacent body panel's edge color
  // (median of a thin strip along the shared crease — a stretched pixel row
  // prints as streaks wherever the photo's edge has text or an outline).
  const strip = 0.06
  for (let i = 0; i < 4; i++) {
    const bot = i % 2 === 0 ? BOT_FB : BOT_LR
    const edge = medianBorderColor(img, rect(colX[i], colX[i] + colW[i], 0, H * strip))
    fillRect(img, mask, rect(colX[i], colX[i] + colW[i], -bot, 0), edge)
  }
  const gx = 2 * W + 2 * D
  const glueEdge = medianBorderColor(img, rect(gx - D * strip * 2, gx, 0, H))
  fillRect(img, mask, rect(gx, gx + GLUE, 0, H), glueEdge)

  bleed(img, mask, Math.round((opts.bleedCm ?? 0.2) * pxPerCm))
  return { image: img, roofColor }
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
}
