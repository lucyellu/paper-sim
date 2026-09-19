// Verifies "Carton from photo…" (photo → foldable, textured gable carton):
//  - File menu opens the wizard from a real file chooser with the Pinterest
//    test image (4 cartons in 3/4 view on black).
//  - 8 scripted corner clicks on the TOP-LEFT carton complete the guide.
//  - Build makes a gable doc with sane, one-Letter-page dims, a composed
//    overlay whose front-body / roof / side regions are the carton's paper
//    (not the photo's black background), and authored fold steps.
//  - The true-scale PDF with artwork is ONE Letter page.
//  - Screenshots of the wizard, the flat sheet and the folded 3D carton land in
//    scripts/shots/.
// Usage: node scripts/verify-v12.mjs   (dev server must be running;
// needs the local-only reference/dieline/pinterest_4081455908182799.jpg)
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const IMAGE = fileURLToPath(new globalThis.URL('../../reference/dieline/pinterest_4081455908182799.jpg', import.meta.url))
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
if (!existsSync(IMAGE)) {
  console.error(`test image missing: ${IMAGE}`)
  process.exit(1)
}

// Top-left carton, image px (1200×1200): body "Y" bottom L→R, top L→R, ridge L, R.
// Front (MRAM label) is the wider RIGHT face.
const CLICKS = [
  { x: 146, y: 474 },
  { x: 243, y: 553 },
  { x: 486, y: 511 },
  { x: 143, y: 139 },
  { x: 246, y: 194 },
  { x: 486, y: 165 },
  { x: 213, y: 53 },
  { x: 428, y: 18 },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text())
})
await page.goto(URL)
await page.waitForFunction(() => 'paperSim' in window && 'paperSimViewer' in window)
await page.waitForTimeout(400)

// ---- 1. Open the wizard through the File menu ---------------------------------
await page.locator('.menu-label', { hasText: 'File' }).click()
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.locator('.menu-item', { hasText: 'Carton from photo' }).click(),
])
await chooser.setFiles(IMAGE)
const canvas = page.locator('canvas.photo-canvas')
await page.waitForFunction(() => Number(document.querySelector('canvas.photo-canvas')?.dataset.imgW) > 0)
const promptBefore = await page.locator('.photo-prompt').innerText()

// ---- 2. Eight guided clicks ---------------------------------------------------
const box = await canvas.boundingBox()
const imgW = Number(await canvas.getAttribute('data-img-w'))
const imgH = Number(await canvas.getAttribute('data-img-h'))
for (const p of CLICKS) {
  await page.mouse.click(box.x + (p.x / imgW) * box.width, box.y + (p.y / imgH) * box.height)
}
await page.waitForTimeout(400) // debounced flat preview
const promptAfter = await page.locator('.photo-prompt').innerText()
const fieldDims = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('input[data-dim]')].map((i) => [i.dataset.dim, Number(i.value)])),
)
await page.locator('.photo-modal').screenshot({ path: SHOTS + 'v12-wizard.png' })
const wizardOk =
  /Click 1 of 8/.test(promptBefore) && /All 8 set/.test(promptAfter) && fieldDims.height > 0

// ---- 3. Build ------------------------------------------------------------------
await page.locator('.photo-modal button.primary', { hasText: 'Build carton' }).click()
await page.waitForFunction(() => !document.querySelector('.photo-modal'))
await page.waitForTimeout(600)

const built = await page.evaluate(async () => {
  const P = window.paperSim
  const st = P.store.getState()
  const doc = st.doc
  const names = doc.faces.map((f) => f.name)
  const isGable = names.includes('front roof') && names.includes('left side gusset')
  const { min, max } = P.sheetBounds(doc)
  const bboxOf = (name) => {
    const f = doc.faces.find((q) => q.name === name)
    const ps = f.vertexIds.map((id) => doc.vertices.find((v) => v.id === id).pos)
    return {
      x0: Math.min(...ps.map((p) => p.x)),
      x1: Math.max(...ps.map((p) => p.x)),
      y0: Math.min(...ps.map((p) => p.y)),
      y1: Math.max(...ps.map((p) => p.y)),
    }
  }
  const front = bboxOf('front')
  const dims = { width: front.x1 - front.x0, height: front.y1 - front.y0, depth: bboxOf('right side').x1 - bboxOf('right side').x0 }
  const overlay = st.material.overlayImage ?? ''
  // Decode the composed overlay and average the inner 60% of a few panels.
  const img = new Image()
  img.src = overlay
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const mean = (b) => {
    const px = (x) => ((x - min.x) / (max.x - min.x)) * c.width
    const py = (y) => ((max.y - y) / (max.y - min.y)) * c.height
    const ix = px(b.x0 + (b.x1 - b.x0) * 0.2)
    const iy = py(b.y1 - (b.y1 - b.y0) * 0.2)
    const w = px(b.x1 - (b.x1 - b.x0) * 0.2) - ix
    const h = py(b.y0 + (b.y1 - b.y0) * 0.2) - iy
    const d = ctx.getImageData(Math.round(ix), Math.round(iy), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data
    let r = 0, g = 0, bl = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]
      g += d[i + 1]
      bl += d[i + 2]
    }
    const n = d.length / 4
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)]
  }
  const regions = {
    frontBody: mean(front),
    backBody: mean(bboxOf('back')),
    leftSide: mean(bboxOf('left side')),
    frontRoof: mean(bboxOf('front roof')),
    frontFlap: mean(bboxOf('front bottom flap')),
  }
  const pdf = await P.dielinePDFTrueScale(doc, st.projectName, st.material, st.uvEdits)
  const bytes = new Uint8Array(await pdf.arrayBuffer())
  let text = ''
  for (let i = 0; i < bytes.length; i += 65536) text += String.fromCharCode(...bytes.subarray(i, i + 65536))
  const pages = (text.match(/\/Type \/Page\b(?!s)/g) ?? []).length
  const mediaBox = (text.match(/\/MediaBox \[([^\]]+)\]/) ?? [])[1]
  return {
    isGable,
    projectName: st.projectName,
    dims,
    sheet: { w: max.x - min.x, h: max.y - min.y },
    overlayKind: overlay.slice(0, 15),
    overlaySize: [img.width, img.height],
    regions,
    steps: st.steps.length,
    pdf: { magic: text.slice(0, 5), pages, mediaBox },
  }
})
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b
const d = built.dims
const dimsOk =
  d.width > 2 && d.depth > 1 && d.height > 3 && d.width < 20 && d.depth <= d.width + 1e-6 &&
  built.sheet.w <= 25.75 && built.sheet.h <= 18.48
const notBlack = Object.values(built.regions).every((c) => lum(c) > 90)
const buildOk = built.isGable && dimsOk && built.overlayKind.startsWith('data:image/') && notBlack && built.steps > 0
const pdfOk = built.pdf.magic === '%PDF-' && built.pdf.pages === 1

// ---- 4. Screenshots: flat sheet + folded carton --------------------------------
await page.screenshot({ path: SHOTS + 'v12-flat.png' })
await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.setAnglesTransient({ ...st.doc.targetAngles })
})
await page.waitForTimeout(800)
await page.screenshot({ path: SHOTS + 'v12-folded.png' })
// Stand it upright (the app lays folded models on their side) to compare with the photo.
await page.evaluate(() => window.paperSim.store.getState().rotateObject('x', 90))
await page.waitForTimeout(500)
await page.screenshot({ path: SHOTS + 'v12-folded-upright.png' })

const result = { promptBefore, promptAfter, fieldDims, wizardOk, built, dimsOk, notBlack, buildOk, pdfOk, pageErrors }
const ok = wizardOk && buildOk && pdfOk && pageErrors.length === 0
console.log(JSON.stringify({ ...result, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
