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
    ratios: null,
    confidence: 'none',
    overlay,
  })
  const identity: OverlayTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 }

  // ---- 1. Foreground mask: transparency if present, else border-color diff.
  let borderTransparent = 0
  let borderCount = 0
  const sampleBorder = (x: number, y: number) => {
    borderCount++
    if (px[(y * W + x) * 4 + 3] < 128) borderTransparent++
  }
  for (let x = 0; x < W; x++) {
    sampleBorder(x, 0)
    sampleBorder(x, H - 1)
  }
  for (let y = 0; y < H; y++) {
    sampleBorder(0, y)
    sampleBorder(W - 1, y)
  }
  const alphaMode = borderTransparent > borderCount * 0.25

  let bgR = 0
  let bgG = 0
  let bgB = 0
  if (!alphaMode) {
    // Background color = average of the four 3×3 corner patches.
    let n = 0
    for (const [cx, cy] of [
      [1, 1],
      [W - 2, 1],
      [1, H - 2],
      [W - 2, H - 2],
    ]) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((cy + dy) * W + (cx + dx)) * 4
          bgR += px[i]
          bgG += px[i + 1]
          bgB += px[i + 2]
          n++
        }
      }
    }
    bgR /= n
    bgG /= n
    bgB /= n
  }

  const mask = new Uint8Array(W * H)
  const lum = new Float32Array(W * H)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const a = px[p + 3]
    lum[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) * (a / 255)
    mask[i] = alphaMode
      ? a > 32
        ? 1
        : 0
      : Math.abs(px[p] - bgR) + Math.abs(px[p + 1] - bgG) + Math.abs(px[p + 2] - bgB) > 48 && a > 32
        ? 1
        : 0
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
