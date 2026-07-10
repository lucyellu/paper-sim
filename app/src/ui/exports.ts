// Export helpers: dieline SVG (cut/crease line work), the printable
// instruction sheet (dieline + numbered 3D snapshots per fold step), and the
// project bundle (zip with the .fold, dieline, model snapshot, instructions).

import { sheetBounds, type PaperDoc } from '../model/document'
import { toFoldFile } from '../model/foldfile'
import { nextExportName, slugify } from '../model/naming'
import type { Step } from '../model/ops'
import { getDisplayAngles, type AppState } from '../state/store'
import { captureAvailable, capturePoses } from '../viewer/capture'
import { buildZip, dataUrlBytes, type ZipEntry } from './zip'

/** Build a standalone SVG string of the dieline (cuts solid, creases dashed). */
export function dielineSVG(doc: PaperDoc): string {
  const { min, max } = sheetBounds(doc)
  const pad = 1
  const w = max.x - min.x + 2 * pad
  const h = max.y - min.y + 2 * pad
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${min.x - pad} ${-(max.y + pad)} ${w} ${h}" width="${w * 24}" height="${h * 24}">
<rect x="${min.x - pad}" y="${-(max.y + pad)}" width="${w}" height="${h}" fill="#faf6ec"/>
${lines}
</svg>`
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
 * .fold file (model + full history), the dieline SVG, a snapshot of the
 * current 3D pose, and the instruction sheet (when there are steps). The zip
 * name iterates per project so exports never overwrite each other.
 * Returns the file name it downloaded as.
 */
export function exportProjectBundle(s: AppState): string {
  const slug = slugify(s.projectName)
  const fold = toFoldFile(s.doc, s.angles, s.steps, s.history, s.objectRotation, s.projectName)
  const entries: ZipEntry[] = [
    { name: `${slug}/${slug}.fold`, data: JSON.stringify(fold, null, 2) },
    { name: `${slug}/${slug}_dieline.svg`, data: dielineSVG(s.doc) },
  ]
  if (captureAvailable()) {
    const png = capturePoses([getDisplayAngles(s)], { w: 1200, h: 900 })[0]
    entries.push({ name: `${slug}/${slug}_model.png`, data: dataUrlBytes(png) })
    const sheet = buildInstructionSheetHTML(s.doc, s.steps, s.projectName)
    if (sheet) entries.push({ name: `${slug}/${slug}_instructions.html`, data: sheet })
  }
  const zipName = nextExportName(s.projectName, 'project', 'zip')
  downloadBlob(buildZip(entries), zipName)
  return zipName
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
