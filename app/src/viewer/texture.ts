// Builds the sheet texture canvas from the material settings: base color,
// procedural kraft-paper tile or uploaded base image (tiled), plus the design
// overlay stretched across the whole dieline. The canvas maps 1:1 onto the
// flat sheet bounds — face UVs are the flat coordinates normalized to those
// bounds, so the dieline acts as the UV map of the folded object.

import { sheetBounds, type PaperDoc } from '../model/document'
import type { MaterialSettings } from '../model/material'

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
