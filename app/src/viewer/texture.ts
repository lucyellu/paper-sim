// Builds the sheet texture canvas from the material settings: base color,
// procedural kraft-paper tile or uploaded base image (tiled), plus the design
// overlay stretched across the whole dieline. The canvas maps 1:1 onto the
// flat sheet bounds — face UVs are the flat coordinates normalized to those
// bounds, so the dieline acts as the UV map of the folded object.

import { sheetBounds, vertexById, type PaperDoc } from '../model/document'
import type { MaterialSettings } from '../model/material'
import {
  composeAffine,
  faceUVAffine,
  faceUVCentroid,
  invertAffine,
  isIdentityFaceUV,
  type UVEdits,
} from '../model/uv'

const MAX_TEX = 2048

/** True when the material needs a texture map (vs a flat material color). */
export function materialNeedsTexture(m: MaterialSettings): boolean {
  return m.baseKind !== 'color' || !!m.overlayImage
}

export async function buildSheetCanvas(
  doc: PaperDoc,
  material: MaterialSettings,
): Promise<HTMLCanvasElement> {
  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 0.001)
  const h = Math.max(max.y - min.y, 0.001)
  const scale = MAX_TEX / Math.max(w, h)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(8, Math.round(w * scale))
  canvas.height = Math.max(8, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = material.baseColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (material.baseKind === 'kraft') {
    tileOnto(ctx, kraftTile(material.baseColor), canvas.width, canvas.height)
  } else if (material.baseKind === 'image' && material.baseImage) {
    try {
      tileOnto(ctx, await loadImage(material.baseImage), canvas.width, canvas.height)
    } catch {
      // Bad image data: keep the flat base color.
    }
  }

  if (material.overlayImage) {
    try {
      const img = await loadImage(material.overlayImage)
      const t = material.overlayTransform
      const cw = canvas.width
      const ch = canvas.height
      if (!t) {
        ctx.drawImage(img, 0, 0, cw, ch)
      } else {
        // Place the image into a scaled/offset rect and rotate about its center.
        const iw = cw * t.scaleX
        const ih = ch * t.scaleY
        const ix = t.offsetX * cw
        const iy = t.offsetY * ch
        ctx.save()
        ctx.translate(ix + iw / 2, iy + ih / 2)
        ctx.rotate((t.rotationDeg * Math.PI) / 180)
        ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih)
        ctx.restore()
      }
    } catch {
      // Bad image data: skip the overlay.
    }
  }
  return canvas
}

/**
 * The sheet artwork as it must be PRINTED: buildSheetCanvas plus per-face UV
 * compensation. A face whose UVs were shifted samples a different part of the
 * artwork in 3D; here that same artwork region is pulled back into the face's
 * dieline position (inverse affine warp, clipped to the face polygon), so a
 * printed-and-folded sheet matches the 3D preview exactly. With no UV edits
 * this returns buildSheetCanvas unchanged.
 */
export async function buildPrintCanvas(
  doc: PaperDoc,
  material: MaterialSettings,
  uvEdits?: UVEdits,
): Promise<HTMLCanvasElement> {
  const base = await buildSheetCanvas(doc, material)
  const edited = doc.faces.filter((f) => {
    const t = uvEdits?.[f.id]
    return t && !isIdentityFaceUV(t)
  })
  if (edited.length === 0) return base

  const out = document.createElement('canvas')
  out.width = base.width
  out.height = base.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(base, 0, 0)

  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 0.001)
  const h = Math.max(max.y - min.y, 0.001)
  // UV space (v up) -> canvas px (y down): x = u·W, y = (1 − v)·H.
  const F = { a: out.width, b: 0, c: 0, d: -out.height, e: 0, f: out.height }
  const Finv = invertAffine(F)

  for (const face of edited) {
    const t = uvEdits![face.id]
    const c = faceUVCentroid(doc, face)
    // Printed pixel q must show base(F·T·F⁻¹(q)); drawImage with transform M
    // shows base(M⁻¹·q), so M = F·T⁻¹·F⁻¹.
    const M = composeAffine(F, composeAffine(invertAffine(faceUVAffine(t, c)), Finv))
    ctx.save()
    ctx.beginPath()
    face.vertexIds.forEach((vid, i) => {
      const p = vertexById(doc, vid).pos
      const x = ((p.x - min.x) / w) * out.width
      const y = (1 - (p.y - min.y) / h) * out.height
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.clip()
    // Where the warp samples outside the artwork, print the base paper color.
    ctx.fillStyle = material.baseColor
    ctx.fill()
    ctx.setTransform(M.a, M.b, M.c, M.d, M.e, M.f)
    ctx.drawImage(base, 0, 0)
    ctx.restore()
  }
  return out
}

function tileOnto(
  ctx: CanvasRenderingContext2D,
  tile: HTMLCanvasElement | HTMLImageElement,
  w: number,
  h: number,
) {
  const tw = tile.width
  const th = tile.height
  if (tw === 0 || th === 0) return
  for (let y = 0; y < h; y += th) {
    for (let x = 0; x < w; x += tw) ctx.drawImage(tile, x, y)
  }
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not decode image'))
    img.src = dataUrl
  })
}

/**
 * Procedural kraft/chipboard paper tile: the base color with grain noise,
 * dark and colored specks, and a few pale fibers.
 */
export function kraftTile(baseColor: string, size = 256): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = baseColor
  ctx.fillRect(0, 0, size, size)

  const id = ctx.getImageData(0, 0, size, size)
  const px = id.data
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 14
    px[i] += n
    px[i + 1] += n
    px[i + 2] += n
  }
  ctx.putImageData(id, 0, 0)

  const speckColors = [
    'rgba(75, 62, 44, 0.75)',
    'rgba(52, 44, 33, 0.7)',
    'rgba(120, 100, 70, 0.6)',
    'rgba(140, 50, 35, 0.45)',
    'rgba(60, 70, 110, 0.35)',
  ]
  for (let i = 0; i < 150; i++) {
    ctx.fillStyle = speckColors[Math.floor(Math.random() * speckColors.length)]
    const s = Math.random() < 0.85 ? 1 : 2
    ctx.fillRect(Math.random() * size, Math.random() * size, s, s)
  }

  for (let i = 0; i < 36; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const a = Math.random() * Math.PI
    const len = 4 + Math.random() * 10
    ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(90,75,55,0.12)'
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
    ctx.stroke()
  }
  return c
}
