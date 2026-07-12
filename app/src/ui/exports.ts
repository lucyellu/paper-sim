// Export helpers: dieline SVG (cut/crease line work), the printable
// instruction sheet (dieline + numbered 3D snapshots per fold step), and the
// project bundle (zip with the .fold, dieline, model snapshot, instructions).

import { sheetBounds, type PaperDoc } from '../model/document'
import { toFoldFile } from '../model/foldfile'
import type { MaterialSettings } from '../model/material'
import { nextExportName, slugify } from '../model/naming'
import type { Step } from '../model/ops'
import { getDisplayAngles, type AppState } from '../state/store'
import { captureAvailable, capturePoses } from '../viewer/capture'
import { buildSheetCanvas, loadImage } from '../viewer/texture'
import { Pdf, type RGB } from './pdf'
import { buildZip, dataUrlBytes, type ZipEntry } from './zip'

const PDF_INK: RGB = [0.23, 0.2, 0.15]
const PDF_MUTED: RGB = [0.48, 0.42, 0.31]
/** US Letter (8.5×11 in) — the paper in the target audience's home printer. */
const PAGE_W = 612
const PAGE_H = 792
const PDF_LEGEND = 'solid = cut   ·   dashed blue = valley fold   ·   dashed red = mountain fold'

/**
 * Build a standalone SVG string of the dieline (cuts solid, creases dashed).
 * Pass an `artwork` data URL (from dielineTextureCanvas) to composite the
 * printed design under the line work instead of a blank cream background.
 */
export function dielineSVG(doc: PaperDoc, artwork?: string): string {
  const { min, max } = sheetBounds(doc)
  const pad = 1
  const w = max.x - min.x + 2 * pad
  const h = max.y - min.y + 2 * pad
  const sw = max.x - min.x
  const sh = max.y - min.y
  const pos = (id: number) => doc.vertices.find((v) => v.id === id)!.pos
  const lines = doc.edges
    .map((e) => {
      const a = pos(e.v1)
      const b = pos(e.v2)
      const target = doc.targetAngles?.[e.id]
      const isCut = e.kind === 'cut'
      const color = isCut ? '#3b3327' : (target ?? 0) < 0 ? '#dc2626' : '#2563eb'
      const dash = isCut ? '' : ' stroke-dasharray="0.42 0.24"'
      // SVG y grows downward; the dieline's y grows upward.
      return `  <line x1="${a.x}" y1="${-a.y}" x2="${b.x}" y2="${-b.y}" stroke="${color}" stroke-width="${isCut ? 0.1 : 0.07}"${dash} stroke-linecap="round"/>`
    })
    .join('\n')
  // Artwork spans the sheet bounds exactly (its top-left = min.x, max.y in doc).
  const art = artwork
    ? `\n<image href="${artwork}" x="${min.x}" y="${-max.y}" width="${sw}" height="${sh}" preserveAspectRatio="none"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${min.x - pad} ${-(max.y + pad)} ${w} ${h}" width="${w * 24}" height="${h * 24}">
<rect x="${min.x - pad}" y="${-(max.y + pad)}" width="${w}" height="${h}" fill="#faf6ec"/>${art}
${lines}
</svg>`
}

/**
 * Render the flat dieline WITH its printed design: the material's sheet texture
 * (base + overlay art) with the cut/crease line work drawn on top. Returns a
 * canvas covering the sheet bounds (canvas px (0,0) = doc (min.x, max.y)).
 */
export async function dielineTextureCanvas(
  doc: PaperDoc,
  material: MaterialSettings,
): Promise<HTMLCanvasElement> {
  const canvas = await buildSheetCanvas(doc, material)
  const { min, max } = sheetBounds(doc)
  const w = Math.max(max.x - min.x, 0.001)
  const scale = canvas.width / w
  const ctx = canvas.getContext('2d')!
  const pos = (id: number) => doc.vertices.find((v) => v.id === id)!.pos
  ctx.lineCap = 'round'
  for (const e of doc.edges) {
    const a = pos(e.v1)
    const b = pos(e.v2)
    const isCut = e.kind === 'cut'
    const target = doc.targetAngles?.[e.id]
    ctx.strokeStyle = isCut ? '#2c2519' : (target ?? 0) < 0 ? '#dc2626' : '#2563eb'
    ctx.lineWidth = Math.max(1, scale * (isCut ? 0.05 : 0.035))
    ctx.setLineDash(isCut ? [] : [scale * 0.3, scale * 0.2])
    ctx.beginPath()
    ctx.moveTo((a.x - min.x) * scale, (max.y - a.y) * scale)
    ctx.lineTo((b.x - min.x) * scale, (max.y - b.y) * scale)
    ctx.stroke()
  }
  ctx.setLineDash([])
  return canvas
}

/** The sheet artwork (base + overlay, no line work) as a PNG data URL. */
export async function dielineArtworkDataUrl(
  doc: PaperDoc,
  material: MaterialSettings,
): Promise<string> {
  const canvas = await buildSheetCanvas(doc, material)
  return canvas.toDataURL('image/png')
}

/** Composite the textured dieline to a PNG blob. */
export async function dielineTexturePNG(doc: PaperDoc, material: MaterialSettings): Promise<Blob> {
  const canvas = await dielineTextureCanvas(doc, material)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'),
  )
}

export function downloadText(text: string, fileName: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), fileName)
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

interface ImageBytes {
  bytes: Uint8Array
  w: number
  h: number
}

/** JPEG-encode a canvas for embedding in a PDF. */
function canvasToJpeg(canvas: HTMLCanvasElement): ImageBytes {
  return { bytes: dataUrlBytes(canvas.toDataURL('image/jpeg', 0.92)), w: canvas.width, h: canvas.height }
}

/** Draw the dieline's line work into a rect of a PDF page (fit + centered). */
function drawDielineInto(pdf: Pdf, doc: PaperDoc, x: number, y: number, w: number, h: number) {
  const { min, max } = sheetBounds(doc)
  const sw = Math.max(max.x - min.x, 0.001)
  const sh = Math.max(max.y - min.y, 0.001)
  const scale = Math.min(w / sw, h / sh)
  const ox = x + (w - sw * scale) / 2 - min.x * scale
  const oy = y + (h - sh * scale) / 2 - min.y * scale
  const pos = (id: number) => doc.vertices.find((v) => v.id === id)!.pos
  for (const e of doc.edges) {
    const a = pos(e.v1)
    const b = pos(e.v2)
    const isCut = e.kind === 'cut'
    const target = doc.targetAngles?.[e.id]
    const color: RGB = isCut
      ? PDF_INK
      : (target ?? 0) < 0
        ? [0.86, 0.15, 0.15]
        : [0.15, 0.39, 0.92]
    // PDF y grows upward, like the dieline's — no flip needed.
    pdf.line(
      ox + a.x * scale,
      oy + a.y * scale,
      ox + b.x * scale,
      oy + b.y * scale,
      isCut ? 1.1 : 0.8,
      color,
      isCut ? undefined : [3.5, 2.2],
    )
  }
}

/**
 * The flat pattern as a printable one-page PDF (true vector line work). Pass a
 * material to composite the printed design under the lines (textured dieline).
 */
export async function dielinePDF(
  doc: PaperDoc,
  title: string,
  material?: MaterialSettings,
): Promise<Blob> {
  const { min, max } = sheetBounds(doc)
  const landscape = max.x - min.x > max.y - min.y
  const [pw, ph] = landscape ? [PAGE_H, PAGE_W] : [PAGE_W, PAGE_H]
  const pdf = new Pdf()
  pdf.addPage(pw, ph)
  const m = 48
  const withArt = material ? ' (with artwork)' : ''
  pdf.text(m, ph - m, 16, `${title} — dieline${withArt}`, { bold: true, color: PDF_INK })
  pdf.text(m, ph - m - 16, 9, PDF_LEGEND, { color: PDF_MUTED })
  if (material) {
    // dielineTextureCanvas already bakes the line work onto the art: fit it.
    const art = canvasToJpeg(await dielineTextureCanvas(doc, material))
    const bw = pw - 2 * m
    const bh = ph - 2 * m - 34
    const scale = Math.min(bw / art.w, bh / art.h)
    const iw = art.w * scale
    const ih = art.h * scale
    pdf.imageJpeg(art.bytes, art.w, art.h, m + (bw - iw) / 2, m + (bh - ih) / 2, iw, ih)
  } else {
    drawDielineInto(pdf, doc, m, m, pw - 2 * m, ph - 2 * m - 34)
  }
  return pdf.save()
}

/** PDF points per dieline unit: 1 unit = 1 cm (72 pt = 1 inch = 2.54 cm). */
const CM_TO_PT = 72 / 2.54

/**
 * The dieline at TRUE physical scale (1 unit = 1 cm, print at 100%): the
 * printable counterpart of dielinePDF's fit-to-page preview. A dieline that
 * fits one A4 page is centered; a bigger one tiles across pages row by row
 * (top-left first) with a trim frame around each tile's content. Every page
 * footer states the scale; the first page carries a 5 cm calibration bar so a
 * mis-scaled print is obvious. Artwork (when a material is passed) embeds
 * once and is drawn per tile under vector line work.
 */
export async function dielinePDFTrueScale(
  doc: PaperDoc,
  title: string,
  material?: MaterialSettings,
): Promise<Blob> {
  const { min, max } = sheetBounds(doc)
  const padCm = 0.25 // breathing room so cut lines don't sit on the trim frame
  const sheetW = (max.x - min.x + 2 * padCm) * CM_TO_PT
  const sheetH = (max.y - min.y + 2 * padCm) * CM_TO_PT
  const m = 24 // page margin (pt) — printable on typical printers
  const footerH = 26
  const layout = (pw: number, ph: number) => {
    const cw = pw - 2 * m
    const ch = ph - 2 * m - footerH
    return { pw, ph, cw, ch, cols: Math.ceil(sheetW / cw), rows: Math.ceil(sheetH / ch) }
  }
  const portrait = layout(PAGE_W, PAGE_H)
  const landscape = layout(PAGE_H, PAGE_W)
  const lay =
    landscape.cols * landscape.rows < portrait.cols * portrait.rows ? landscape : portrait
  const single = lay.cols === 1 && lay.rows === 1

  const pdf = new Pdf()
  let artIdx = -1
  if (material) {
    const art = canvasToJpeg(await buildSheetCanvas(doc, material))
    artIdx = pdf.addImage(art.bytes, art.w, art.h)
  }
  const pos = (id: number) => doc.vertices.find((v) => v.id === id)!.pos

  for (let r = 0; r < lay.rows; r++) {
    for (let c = 0; c < lay.cols; c++) {
      pdf.addPage(lay.pw, lay.ph)
      const contentX = m
      const contentY = m + footerH
      // Sheet-space -> page-space: pageX = ox + x·S, pageY = oy + y·S. Tile
      // (r,c) shows the band [c·cw, (c+1)·cw] × [top − (r+1)·ch, top − r·ch].
      const cx = single ? contentX + (lay.cw - sheetW) / 2 : contentX
      const cyTop = single ? contentY + (lay.ch + sheetH) / 2 : contentY + lay.ch
      const ox = cx - (min.x - padCm) * CM_TO_PT - c * lay.cw
      const oy = cyTop - (max.y + padCm) * CM_TO_PT + r * lay.ch
      pdf.pushClip(contentX, contentY, lay.cw, lay.ch)
      if (artIdx >= 0) {
        pdf.drawImage(
          artIdx,
          ox + min.x * CM_TO_PT,
          oy + min.y * CM_TO_PT,
          (max.x - min.x) * CM_TO_PT,
          (max.y - min.y) * CM_TO_PT,
        )
      }
      for (const e of doc.edges) {
        const a = pos(e.v1)
        const b = pos(e.v2)
        const isCut = e.kind === 'cut'
        const target = doc.targetAngles?.[e.id]
        const color: RGB = isCut ? PDF_INK : (target ?? 0) < 0 ? [0.86, 0.15, 0.15] : [0.15, 0.39, 0.92]
        pdf.line(
          ox + a.x * CM_TO_PT,
          oy + a.y * CM_TO_PT,
          ox + b.x * CM_TO_PT,
          oy + b.y * CM_TO_PT,
          isCut ? 1.1 : 0.8,
          color,
          isCut ? undefined : [3.5, 2.2],
        )
      }
      pdf.pop()
      if (!single) {
        // Trim frame: cut here and butt tiles edge-to-edge to reassemble.
        pdf.rect(contentX, contentY, lay.cw, lay.ch, 0.5, [0.7, 0.66, 0.58])
      }
      const tile = single ? '' : ` · tile ${r + 1},${c + 1} of ${lay.rows}×${lay.cols} (cut on the gray frame, butt tiles together)`
      pdf.text(m, m + 6, 8, `${title} — dieline · TRUE SCALE (1 unit = 1 cm) · print at 100% on US Letter, no fit-to-page${tile}`, {
        color: PDF_MUTED,
      })
      if (r === 0 && c === 0) {
        // 5 cm calibration bar, right-aligned in the footer.
        const barW = 5 * CM_TO_PT
        const bx = lay.pw - m - barW
        const by = m + 8
        pdf.line(bx, by, bx + barW, by, 1, PDF_INK)
        pdf.line(bx, by - 3, bx, by + 3, 1, PDF_INK)
        pdf.line(bx + barW, by - 3, bx + barW, by + 3, 1, PDF_INK)
        pdf.text(bx + barW / 2 - 14, by + 5, 8, '5 cm', { color: PDF_INK })
      }
    }
  }
  return pdf.save()
}

async function pngDataUrlToJpeg(
  dataUrl: string,
): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const img = await loadImage(dataUrl)
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0)
  return { bytes: dataUrlBytes(c.toDataURL('image/jpeg', 0.9)), w: c.width, h: c.height }
}

/**
 * The instruction sheet as a multi-page PDF: title + vector dieline, then a
 * grid of step snapshots. Null if there are no steps.
 */
export async function instructionsPDF(
  doc: PaperDoc,
  steps: Step[],
  title: string,
): Promise<Blob | null> {
  if (steps.length === 0) return null
  const poses = [{}, ...steps.map((st) => st.angles)]
  const shots = await Promise.all(capturePoses(poses, { w: 720, h: 540 }).map(pngDataUrlToJpeg))

  const pdf = new Pdf()
  const pw = PAGE_W
  const ph = PAGE_H
  const m = 48
  pdf.addPage(pw, ph)
  pdf.text(m, ph - m, 18, `${title} — folding instructions`, { bold: true, color: PDF_INK })
  pdf.text(m, ph - m - 16, 9, PDF_LEGEND, { color: PDF_MUTED })
  pdf.text(m, ph - m - 44, 12, 'Dieline', { bold: true, color: PDF_INK })
  drawDielineInto(pdf, doc, m, m, pw - 2 * m, ph - 2 * m - 62)

  const cols = 2
  const rows = 3
  const gap = 16
  const cellW = (pw - 2 * m - gap * (cols - 1)) / cols
  const imgH = cellW * (540 / 720)
  const cellH = imgH + 24
  shots.forEach((shot, i) => {
    const k = i % (cols * rows)
    if (k === 0) {
      pdf.addPage(pw, ph)
      pdf.text(m, ph - m + 8, 12, 'Folding steps', { bold: true, color: PDF_INK })
    }
    const col = k % cols
    const row = Math.floor(k / cols)
    const x = m + col * (cellW + gap)
    const yTop = ph - m - 16 - row * (cellH + gap)
    pdf.imageJpeg(shot.bytes, shot.w, shot.h, x, yTop - imgH, cellW, imgH)
    const label = i === 0 ? 'Start: flat sheet' : `${i}. ${steps[i - 1].name}`
    pdf.text(x + 2, yTop - imgH - 14, 10, label, { color: PDF_INK })
  })
  return pdf.save()
}

/**
 * The instruction sheet as a self-contained HTML string (snapshots inlined as
 * data URLs), or null if there are no steps to show.
 */
export function buildInstructionSheetHTML(
  doc: PaperDoc,
  steps: Step[],
  title: string,
): string | null {
  if (steps.length === 0) return null
  const poses = [{}, ...steps.map((st) => st.angles)]
  const images = capturePoses(poses)
  const svg = dielineSVG(doc)

  const cards = images
    .map((url, i) => {
      const name = i === 0 ? 'Start: flat sheet' : escapeHtml(steps[i - 1].name)
      return `    <figure class="step">
      <img src="${url}" alt="Step ${i}"/>
      <figcaption><span class="num">${i === 0 ? '·' : i}</span> ${name}</figcaption>
    </figure>`
    })
    .join('\n')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} — folding instructions</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #3b3327; background: #fffdf7;
         max-width: 60rem; margin: 2rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.6rem; border-bottom: 2px solid #d9bc8d; padding-bottom: .4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  .dieline svg { width: 100%; height: auto; border: 1px solid #e2d8c0; border-radius: 8px; }
  .legend { font-size: .85rem; color: #7a6a4f; }
  .legend b { font-weight: 600; }
  .steps { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
           gap: 1rem; margin-top: 1rem; }
  .step { margin: 0; border: 1px solid #e2d8c0; border-radius: 8px; overflow: hidden;
          background: #fff; break-inside: avoid; }
  .step img { width: 100%; display: block; }
  .step figcaption { padding: .5rem .75rem; font-size: .9rem; }
  .num { display: inline-block; min-width: 1.5rem; height: 1.5rem; line-height: 1.5rem;
         text-align: center; background: #e8930c; color: #fff; border-radius: 50%;
         font-weight: 700; margin-right: .5rem; font-family: sans-serif; }
  @media print { body { margin: 0; } .step { page-break-inside: avoid; } }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <h2>Dieline</h2>
  <p class="legend"><b>solid</b> = cut &nbsp;·&nbsp; <b style="color:#2563eb">dashed blue</b> = valley fold &nbsp;·&nbsp; <b style="color:#dc2626">dashed red</b> = mountain fold</p>
  <div class="dieline">${svg}</div>
  <h2>Folding steps</h2>
  <div class="steps">
${cards}
  </div>
</body></html>`
}

/**
 * Render the instruction sheet as a printable page opened in a new tab (print
 * to PDF from there). Returns false if there are no steps to export.
 */
export function openInstructionSheet(doc: PaperDoc, steps: Step[], title: string): boolean {
  const html = buildInstructionSheetHTML(doc, steps, title)
  if (html === null) return false
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank')
  // Give the new tab time to load before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}

/**
 * Download the whole project as a zip: a projectname/ folder holding the
 * .fold file (model + full history), the dieline as SVG and PDF, a snapshot
 * of the current 3D pose, and the instruction sheet as HTML and PDF (when
 * there are steps). The zip name iterates per project so exports never
 * overwrite each other. Returns the file name it downloaded as.
 */
export async function exportProjectBundle(s: AppState): Promise<string> {
  const slug = slugify(s.projectName)
  const fold = toFoldFile(
    s.doc,
    s.angles,
    s.steps,
    s.history,
    s.transform,
    s.projectName,
    s.material,
  )
  const entries: ZipEntry[] = [
    { name: `${slug}/${slug}.fold`, data: JSON.stringify(fold, null, 2) },
    { name: `${slug}/${slug}_dieline.svg`, data: dielineSVG(s.doc) },
    {
      name: `${slug}/${slug}_dieline.pdf`,
      data: new Uint8Array(await (await dielinePDF(s.doc, s.projectName)).arrayBuffer()),
    },
  ]
  if (captureAvailable()) {
    const png = capturePoses([getDisplayAngles(s)], { w: 1200, h: 900 })[0]
    entries.push({ name: `${slug}/${slug}_model.png`, data: dataUrlBytes(png) })
    const sheet = buildInstructionSheetHTML(s.doc, s.steps, s.projectName)
    if (sheet) entries.push({ name: `${slug}/${slug}_instructions.html`, data: sheet })
    const pdf = await instructionsPDF(s.doc, s.steps, s.projectName)
    if (pdf) {
      entries.push({
        name: `${slug}/${slug}_instructions.pdf`,
        data: new Uint8Array(await pdf.arrayBuffer()),
      })
    }
  }
  const zipName = nextExportName(s.projectName, 'project', 'zip')
  downloadBlob(buildZip(entries), zipName)
  return zipName
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
