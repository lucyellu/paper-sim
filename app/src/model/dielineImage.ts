// Raster dieline analysis (image → dieline): turn a flat packaging-dieline
// picture (a jpg/png like the reference folder) into (a) gable-carton
// dimensions that match the drawing and (b) an overlay transform that
// registers the artwork exactly onto the rebuilt template's sheet — so the 3D
// preview AND the true-scale printout match the picture. The geometry always
// comes from the parametric builder (guaranteed foldable); the image only
// contributes measurements and artwork. This is deliberately NOT free-form
// line vectorization — that's unreliable on raster art; panel-grid estimation
// for a known archetype is robust on clean dieline images.

import type { GableDims } from './gable'
import type { OverlayTransform } from './material'

export interface ContentBox {
  x: number
  y: number
  w: number
  h: number
}

/** Gable dimensions as ratios of the body height (scale-free). */
export interface GableRatios {
  width: number
  depth: number
  gable: number
  rib: number
  botFB: number
  botLR: number
  glue: number
}

export interface DielineImageAnalysis {
  /** Analysis-resolution image size (px). All px fields use this space. */
  imageW: number
  imageH: number
  /** Tight box around the drawing (background/transparency trimmed). */
  content: ContentBox | null
  /** Interior vertical wall fold-line x positions (4 when found). */
  vLines: number[]
  /** Body band: bottom (larger y) and top/shoulder (smaller y) line rows. */
  hBody: { bottom: number; top: number } | null
  /** Gable corner/ridge line row, when found (between shoulder and top). */
  hCorner: number | null
  /**
   * Candidate fold/cut line positions (strongest first-filtered, then sorted
   * by position) for other archetypes' fit guesses: interior vertical lines
   * across the body band, horizontal lines across the whole drawing.
   */
  vCandidates: number[]
  hCandidates: number[]
  ratios: GableRatios | null
  /**
   * good  = wall widths repeat consistently (W D W D) — trust the numbers;
   * rough = a full line set was found but with weak symmetry (check numbers);
   * none  = no usable panel grid — only the artwork fit is available.
   */
  confidence: 'good' | 'rough' | 'none'
  /** Registers the content box onto the sheet bounds (overlay auto-fit). */
  overlay: OverlayTransform
}

const ANALYSIS_MAX = 1000

/** Load + downscale + analyze an image data URL. */
export async function analyzeDielineImage(dataUrl: string): Promise<DielineImageAnalysis> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('could not decode image'))
    el.src = dataUrl
  })
  const s = Math.min(1, ANALYSIS_MAX / Math.max(img.width, img.height, 1))
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(img.width * s))
  c.height = Math.max(2, Math.round(img.height * s))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return analyzeImageData(ctx.getImageData(0, 0, c.width, c.height))
}

/** Pure analysis over pixels (exposed separately so tests can drive it). */
export function analyzeImageData(id: ImageData): DielineImageAnalysis {
  const W = id.width
  const H = id.height
  const px = id.data
  const none = (content: ContentBox | null, overlay: OverlayTransform): DielineImageAnalysis => ({
    imageW: W,
    imageH: H,
    content,
    vLines: [],
    hBody: null,
    hCorner: null,
    vCandidates,
    hCandidates,
    ratios: null,
    confidence: 'none',
    overlay,
  })
  const identity: OverlayTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 }
  // Filled in as they are found; early exits still report what they have.
  let vCandidates: number[] = []
  let hCandidates: number[] = []

  // ---- 1. Foreground mask: background flooded in from the border.
  const mask = floodForeground(px, W, H)
  const lum = new Float32Array(W * H)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    lum[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) * (px[p + 3] / 255)
  }

  // ---- 2. Content box.
  let bx0 = W
  let bx1 = -1
  let by0 = H
  let by1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
  }
  if (bx1 < 0 || bx1 - bx0 < 8 || by1 - by0 < 8) return none(null, identity)
  const content: ContentBox = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 }
  const overlay: OverlayTransform = {
    offsetX: -content.x / content.w,
    offsetY: -content.y / content.h,
    scaleX: W / content.w,
    scaleY: H / content.h,
    rotationDeg: 0,
  }

  // Horizontal line candidates across the full drawing width.
  {
    const e = new Float32Array(H)
    for (let y = by0 + 1; y < by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        if (mask[(y - 1) * W + x] && mask[(y + 1) * W + x]) e[y] += Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x])
      }
    }
    const peaks = findPeaks(e, by0 + 2, by1 - 2, Math.max(3, content.h * 0.015))
    peaks.sort((a, b) => b.e - a.e)
    hCandidates = peaks.slice(0, 16).map((p) => p.x).sort((a, b) => a - b)
  }

  // ---- 3. Body band = the rows where the drawing spans (nearly) full width.
  const cov = new Int32Array(H)
  for (let y = by0; y <= by1; y++) {
    let c = 0
    for (let x = bx0; x <= bx1; x++) c += mask[y * W + x]
    cov[y] = c
  }
  let maxCov = 0
  for (let y = by0; y <= by1; y++) maxCov = Math.max(maxCov, cov[y])
  const bodyRows: number[] = []
  for (let y = by0; y <= by1; y++) if (cov[y] >= maxCov * 0.96) bodyRows.push(y)
  if (bodyRows.length < 5) {
    // Fallback: middle 40% of the content box.
    bodyRows.length = 0
    for (let y = Math.round(by0 + content.h * 0.3); y <= by0 + content.h * 0.7; y++) bodyRows.push(y)
  }

  // ---- 4. Vertical fold lines: column gradient energy across the body rows.
  const vEnergy = new Float32Array(W)
  for (const y of bodyRows) {
    const row = y * W
    for (let x = bx0 + 1; x < bx1; x++) {
      if (mask[row + x - 1] && mask[row + x + 1]) {
        vEnergy[x] += Math.abs(lum[row + x + 1] - lum[row + x - 1])
      }
    }
  }
  const vPeaks = findPeaks(vEnergy, bx0 + 2, bx1 - 2, Math.max(3, content.w * 0.02))
  // Interior candidates only (the box edges are cut outlines, not folds).
  const inner = vPeaks.filter((p) => p.x > bx0 + content.w * 0.02 && p.x < bx1 - content.w * 0.02)
  inner.sort((a, b) => b.e - a.e)
  const candidates = inner.slice(0, 12).map((p) => p.x)
  candidates.sort((a, b) => a - b)
  vCandidates = candidates
  if (candidates.length < 4) return none(content, overlay)

  // Choose the 4 lines splitting the box into the most W-D-W-D-like columns.
  let best: { lines: number[]; cost: number } | null = null
  const idx = [...candidates.keys()]
  for (const a of idx) {
    for (const b of idx) {
      if (b <= a) continue
      for (const cI of idx) {
        if (cI <= b) continue
        for (const d of idx) {
          if (d <= cI) continue
          const xs = [candidates[a], candidates[b], candidates[cI], candidates[d]]
          const seg = [
            xs[0] - bx0,
            xs[1] - xs[0],
            xs[2] - xs[1],
            xs[3] - xs[2],
            bx1 - xs[3], // glue flap
          ]
          if (seg.some((s) => s < content.w * 0.02)) continue
          const w1 = seg[0]
          const d1 = seg[1]
          const w2 = seg[2]
          const d2 = seg[3]
          const glue = seg[4]
          let cost =
            Math.abs(w1 - w2) / Math.max(w1, w2) + Math.abs(d1 - d2) / Math.max(d1, d2)
          if (glue > Math.min(d1, d2)) cost += 1 // glue should be the narrowest strip
          if (!best || cost < best.cost) best = { lines: xs, cost }
        }
      }
    }
  }
  if (!best) return none(content, overlay)
  const [x1, x2, x3, x4] = best.lines
  const w1 = x1 - bx0
  const d1 = x2 - x1
  const w2 = x3 - x2
  const d2 = x4 - x3
  const gluePx = Math.max(bx1 - x4, content.w * 0.01)
  const wPx = (w1 + w2) / 2
  const dPx = (d1 + d2) / 2

  // ---- 5. Horizontal body lines: row gradient energy across the wall columns.
  const hEnergy = new Float32Array(H)
  for (let y = by0 + 1; y < by1; y++) {
    for (let x = bx0; x <= x4; x++) {
      if (mask[(y - 1) * W + x] && mask[(y + 1) * W + x]) {
        hEnergy[y] += Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x])
      }
    }
  }
  const hPeaks = findPeaks(hEnergy, by0 + 2, by1 - 2, Math.max(3, content.h * 0.015))
  hPeaks.sort((a, b) => b.e - a.e)
  // Body top + bottom = the strongest pair at least 35% of the height apart.
  let hBody: { bottom: number; top: number } | null = null
  outer: for (let i = 0; i < hPeaks.length; i++) {
    for (let j = i + 1; j < hPeaks.length; j++) {
      if (Math.abs(hPeaks[i].x - hPeaks[j].x) >= content.h * 0.35) {
        hBody = {
          top: Math.min(hPeaks[i].x, hPeaks[j].x),
          bottom: Math.max(hPeaks[i].x, hPeaks[j].x),
        }
        break outer
      }
    }
  }
  if (!hBody) return none(content, overlay)
  const hPx = hBody.bottom - hBody.top

  // ---- 6. Gable corner line (between the shoulder and the box top).
  let hCorner: number | null = null
  let cornerBest = 0
  for (const p of hPeaks) {
    if (p.x > by0 + content.h * 0.02 && p.x < hBody.top - content.h * 0.03 && p.e > cornerBest) {
      cornerBest = p.e
      hCorner = p.x
    }
  }
  let gPx = hCorner !== null ? hBody.top - hCorner : dPx * 0.75
  gPx = Math.max(gPx, dPx * 0.55) // roof must reach the ridge (G > D/2)
  const ribPx = Math.max(hCorner !== null ? hCorner - by0 : hBody.top - by0 - gPx, hPx * 0.02)

  // ---- 7. Bottom flap depths per column kind.
  const lowestMasked = (xa: number, xb: number): number => {
    for (let y = by1; y >= by0; y--) {
      for (let x = xa; x <= xb; x++) if (mask[y * W + x]) return y
    }
    return hBody.bottom
  }
  const botFBPx = Math.max(lowestMasked(bx0, x1) - hBody.bottom, hPx * 0.02)
  const botLRPx = Math.max(lowestMasked(x1, x2) - hBody.bottom, hPx * 0.02)

  const relW = Math.abs(w1 - w2) / Math.max(w1, w2)
  const relD = Math.abs(d1 - d2) / Math.max(d1, d2)
  // Our builder lays panels out width-first (W D W D + glue); a depth-first
  // image would register shifted by one column — flag it as rough.
  const widthFirst = wPx >= dPx
  const confidence = relW <= 0.12 && relD <= 0.18 && widthFirst ? 'good' : 'rough'

  return {
    imageW: W,
    imageH: H,
    content,
    vLines: best.lines,
    hBody,
    hCorner,
    vCandidates,
    hCandidates,
    ratios: {
      width: wPx / hPx,
      depth: dPx / hPx,
      gable: gPx / hPx,
      rib: ribPx / hPx,
      botFB: botFBPx / hPx,
      botLR: botLRPx / hPx,
      glue: gluePx / hPx,
    },
    confidence,
    overlay,
  }
}

/**
 * Foreground mask (1 = drawing) by flooding the background in from the
 * picture's border. A background pixel is close to the border's median color
 * (`tol`) OR a small step (`step`) from the background pixel next to it — so a
 * vignette or aged-paper tint is still background, while the dieline's outline
 * stops the flood and unprinted flaps drawn only as outlines on the background
 * count as drawing. Transparent pictures use alpha. Works on a ≤ `maxSide`
 * lightly blurred copy (paper grain would otherwise stall the flood) and
 * upsamples the result.
 */
export function floodForeground(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  { tol = 24, step = 6, maxSide = 1000 } = {},
): Uint8Array {
  const out = new Uint8Array(w * h)
  // Transparent background → alpha is the answer.
  let bt = 0
  let bn = 0
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) (bn++, data[(y * w + x) * 4 + 3] < 128 && bt++)
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) (bn++, data[(y * w + x) * 4 + 3] < 128 && bt++)
  if (bt > bn * 0.25) {
    for (let i = 0; i < w * h; i++) out[i] = data[i * 4 + 3] > 32 ? 1 : 0
    return out
  }

  // Box-downscale to ≤ maxSide.
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxSide))
  const lw = Math.ceil(w / f)
  const lh = Math.ceil(h / f)
  const low = new Float32Array(lw * lh * 3)
  const cnt = new Float32Array(lw * lh)
  for (let y = 0; y < h; y++) {
    const ly = (y / f) | 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const j = ly * lw + ((x / f) | 0)
      low[j * 3] += data[i]
      low[j * 3 + 1] += data[i + 1]
      low[j * 3 + 2] += data[i + 2]
      cnt[j]++
    }
  }
  for (let j = 0; j < lw * lh; j++) for (let c = 0; c < 3; c++) low[j * 3 + c] /= cnt[j]
  // 3×3 blur.
  const img = new Float32Array(lw * lh * 3)
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      let n = 0
      let r = 0
      let g = 0
      let b = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= lh) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= lw) continue
          const k = (yy * lw + xx) * 3
          r += low[k]
          g += low[k + 1]
          b += low[k + 2]
          n++
        }
      }
      const k = (y * lw + x) * 3
      img[k] = r / n
      img[k + 1] = g / n
      img[k + 2] = b / n
    }
  }

  // Border median color.
  const border: number[][] = [[], [], []]
  const push = (x: number, y: number) => {
    const k = (y * lw + x) * 3
    for (let c = 0; c < 3; c++) border[c].push(img[k + c])
  }
  for (let x = 0; x < lw; x++) (push(x, 0), push(x, lh - 1))
  for (let y = 1; y < lh - 1; y++) (push(0, y), push(lw - 1, y))
  const med = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1])
  const nearMed = (k: number) =>
    Math.abs(img[k] - med[0]) + Math.abs(img[k + 1] - med[1]) + Math.abs(img[k + 2] - med[2]) <= tol
  const opaque = (j: number, lx: number, ly: number) =>
    data[(Math.min(h - 1, ly * f) * w + Math.min(w - 1, lx * f)) * 4 + 3] > 32

  // Flood from border pixels that match the background.
  const bg = new Uint8Array(lw * lh)
  const queue = new Int32Array(lw * lh)
  let head = 0
  let tail = 0
  const seed = (x: number, y: number) => {
    const j = y * lw + x
    if (!bg[j] && (nearMed(j * 3) || !opaque(j, x, y))) {
      bg[j] = 1
      queue[tail++] = j
    }
  }
  for (let x = 0; x < lw; x++) (seed(x, 0), seed(x, lh - 1))
  for (let y = 0; y < lh; y++) (seed(0, y), seed(lw - 1, y))
  while (head < tail) {
    const j = queue[head++]
    const x = j % lw
    const y = (j / lw) | 0
    const kc = j * 3
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue
      const n = ny * lw + nx
      if (bg[n]) continue
      const kn = n * 3
      const d = Math.abs(img[kn] - img[kc]) + Math.abs(img[kn + 1] - img[kc + 1]) + Math.abs(img[kn + 2] - img[kc + 2])
      if (d <= step || nearMed(kn) || !opaque(n, nx, ny)) {
        bg[n] = 1
        queue[tail++] = n
      }
    }
  }

  // Specks the flood stepped around (grain, dust, stray watermark letters)
  // would stretch the drawing's extent: drop foreground islands under 0.1%.
  const minArea = lw * lh * 0.001
  const comp = new Int32Array(lw * lh)
  for (let s = 0; s < lw * lh; s++) {
    if (bg[s] || comp[s]) continue
    comp[s] = 1
    head = 0
    tail = 0
    queue[tail++] = s
    while (head < tail) {
      const j = queue[head++]
      const x = j % lw
      const y = (j / lw) | 0
      if (x > 0 && !bg[j - 1] && !comp[j - 1]) (comp[j - 1] = 1, (queue[tail++] = j - 1))
      if (x < lw - 1 && !bg[j + 1] && !comp[j + 1]) (comp[j + 1] = 1, (queue[tail++] = j + 1))
      if (y > 0 && !bg[j - lw] && !comp[j - lw]) (comp[j - lw] = 1, (queue[tail++] = j - lw))
      if (y < lh - 1 && !bg[j + lw] && !comp[j + lw]) (comp[j + lw] = 1, (queue[tail++] = j + lw))
    }
    if (tail < minArea) for (let q = 0; q < tail; q++) bg[queue[q]] = 1
  }

  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * lw
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      out[i] = !bg[row + ((x / f) | 0)] && data[i * 4 + 3] > 32 ? 1 : 0
    }
  }
  return out
}

/** Scale the ratio measurements to real gable dims for a chosen body height (cm). */
export function gableDimsFromAnalysis(
  a: DielineImageAnalysis,
  heightCm: number,
): GableDims | null {
  if (!a.ratios || heightCm <= 0) return null
  const r = a.ratios
  const depth = r.depth * heightCm
  return {
    width: r.width * heightCm,
    depth,
    height: heightCm,
    gable: Math.max(r.gable * heightCm, depth * 0.51 * 1.02),
    rib: r.rib * heightCm,
    botFB: r.botFB * heightCm,
    botLR: r.botLR * heightCm,
    glue: r.glue * heightCm,
  }
}

/** Local maxima of `arr` in [from, to], merged so peaks are ≥ minSep apart. */
function findPeaks(
  arr: Float32Array,
  from: number,
  to: number,
  minSep: number,
): Array<{ x: number; e: number }> {
  // Threshold = mean + 1.5σ over the window (line pixels are rare + strong).
  let mean = 0
  let n = 0
  for (let i = from; i <= to; i++) {
    mean += arr[i]
    n++
  }
  if (n === 0) return []
  mean /= n
  let variance = 0
  for (let i = from; i <= to; i++) variance += (arr[i] - mean) ** 2
  const thresh = mean + 1.5 * Math.sqrt(variance / n)

  const raw: Array<{ x: number; e: number }> = []
  for (let i = from + 1; i < to; i++) {
    if (arr[i] >= thresh && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) {
      raw.push({ x: i, e: arr[i] })
    }
  }
  raw.sort((a, b) => b.e - a.e)
  const kept: Array<{ x: number; e: number }> = []
  for (const p of raw) {
    if (kept.every((k) => Math.abs(k.x - p.x) >= minSep)) kept.push(p)
  }
  kept.sort((a, b) => a.x - b.x)
  return kept
}

// ---------------------------------------------------------------------------
// Pieces: many pins show more than one drawing — color variants side by side,
// a pouch or a mockup next to the box, a legend, crop marks. Each separate
// drawing is one connected island of the foreground mask; the big islands are
// the pieces the user can pick from, and small ones (labels, swatches, crop
// marks, divider lines) are ignored.

interface RGBAImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export interface Piece {
  /** Bounding box in the analyzed image's px. */
  x: number
  y: number
  w: number
  h: number
  /** Island area as a fraction of the whole image. */
  area: number
  /** Label value in `PieceMap.labels`. */
  label: number
}

export interface PieceMap {
  width: number
  height: number
  /** Per-pixel island label (0 = background). */
  labels: Int32Array
  /** Kept pieces, biggest first. */
  pieces: Piece[]
}

/**
 * Split a picture into its separate drawings. Pass a copy downscaled to
 * ≤ ~1000 px (labels are per pixel). An island counts as a piece when it
 * covers ≥ `minFrac` of the picture and ≥ `minOfLargest` of the biggest one.
 */
export function findPieces(img: RGBAImage, { minFrac = 0.01, minOfLargest = 0.08 } = {}): PieceMap {
  const W = img.width
  const H = img.height
  const mask = floodForeground(img.data, W, H)
  const labels = new Int32Array(W * H)
  const queue = new Int32Array(W * H)
  const found: Piece[] = []
  let next = 0
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || labels[s]) continue
    const label = ++next
    labels[s] = label
    let head = 0
    let tail = 0
    queue[tail++] = s
    let x0 = W
    let x1 = -1
    let y0 = H
    let y1 = -1
    while (head < tail) {
      const j = queue[head++]
      const x = j % W
      const y = (j / W) | 0
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      // 8-connected: anti-aliased diagonal outlines stay one island.
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const n = yy * W + xx
          if (mask[n] && !labels[n]) {
            labels[n] = label
            queue[tail++] = n
          }
        }
      }
    }
    found.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area: tail / (W * H), label })
  }
  found.sort((a, b) => b.area - a.area)
  const largest = found[0]?.area ?? 0
  const pieces = found.filter((p) => p.area >= minFrac && p.area >= largest * minOfLargest)
  return { width: W, height: H, labels, pieces }
}

/**
 * Keep only the biggest drawing in `full`: everything outside it (and a
 * `pad`-px margin at `low`'s scale, so anti-aliased edges survive) is painted
 * the background color. `low` is the same picture downscaled for
 * `findPieces`. Returns false (and leaves `full` alone) when no piece is found.
 */
export function isolateLargestPiece(full: RGBAImage, low: RGBAImage, pad = 2): boolean {
  const pm = findPieces(low)
  const piece = pm.pieces[0]
  if (!piece) return false
  const { width: lw, height: lh, labels } = pm
  const keep = new Uint8Array(lw * lh)
  for (let y = piece.y; y < piece.y + piece.h; y++) {
    for (let x = piece.x; x < piece.x + piece.w; x++) {
      if (labels[y * lw + x] !== piece.label) continue
      for (let dy = -pad; dy <= pad; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= lh) continue
        for (let dx = -pad; dx <= pad; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < lw) keep[yy * lw + xx] = 1
        }
      }
    }
  }
  // Background = the border's median color (alpha included, so transparent
  // pictures stay transparent).
  const border: number[][] = [[], [], [], []]
  const push = (x: number, y: number) => {
    const k = (y * lw + x) * 4
    for (let c = 0; c < 4; c++) border[c].push(low.data[k + c])
  }
  for (let x = 0; x < lw; x++) (push(x, 0), push(x, lh - 1))
  for (let y = 1; y < lh - 1; y++) (push(0, y), push(lw - 1, y))
  const bg = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1])

  const { width: fw, height: fh, data } = full
  for (let y = 0; y < fh; y++) {
    const row = Math.min(lh - 1, Math.floor((y * lh) / fh)) * lw
    for (let x = 0; x < fw; x++) {
      if (keep[row + Math.min(lw - 1, Math.floor((x * lw) / fw))]) continue
      const i = (y * fw + x) * 4
      data[i] = bg[0]
      data[i + 1] = bg[1]
      data[i + 2] = bg[2]
      data[i + 3] = bg[3]
    }
  }
  return true
}
