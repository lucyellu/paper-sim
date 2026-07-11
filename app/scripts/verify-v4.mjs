// v4 checks: template fold steps, row/column/object click-selection,
// materials (kraft + overlay texture, persistence), PDF exports, and
// panel/section collapse UI.
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.goto(URL)
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
const out = {}

// 1. Templates ship with playable fold steps, baked (not undoable).
out.templates = await page.evaluate(() => {
  const { store } = window.paperSim
  store.getState().newDocument('gable')
  const s = store.getState()
  const names = s.steps.map((st) => st.name)
  const last = s.steps[s.steps.length - 1].angles
  const t = s.doc.targetAngles
  const reached = Object.keys(t).every((k) => Math.abs((last[k] ?? 0) - t[k]) < 1e-9)
  const undoable = store.getState().canUndo()
  store.getState().newDocument('tuck')
  const tuckSteps = store.getState().steps.length
  return { names, reached, undoable, tuckSteps }
})

// 2. Row / column selection helpers (Maya-style loop select).
out.selection = await page.evaluate(() => {
  const { store, rowFaceIds, columnFaceIds } = window.paperSim
  store.getState().newDocument('gable')
  const s = store.getState()
  const front = s.doc.faces.find((f) => f.name === 'front')
  const nameOf = (id) => s.doc.faces.find((f) => f.id === id).name
  return {
    row: rowFaceIds(s.doc, front.id).map(nameOf),
    col: columnFaceIds(s.doc, front.id).map(nameOf),
    total: s.doc.faces.length,
  }
})

// 2b. Multi-click in the 2D inset: dblclick = row, triple-click = object.
await page.evaluate(() => window.paperSim.store.getState().selectFace(null))
const inset = page.locator('.inset polygon').first()
await inset.dblclick()
out.dblclickCount = await page.evaluate(
  () => window.paperSim.store.getState().selection.length,
)
await inset.click({ clickCount: 3 })
out.tripleclickCount = await page.evaluate(
  () => window.paperSim.store.getState().selection.length,
)

// 3. Material: kraft + overlay builds a texture map; survives save/load.
out.material = await page.evaluate(async () => {
  const { store, toFoldFile } = window.paperSim
  const c = document.createElement('canvas')
  c.width = c.height = 8
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ff4488'
  ctx.fillRect(0, 0, 8, 8)
  const overlay = c.toDataURL('image/png')
  store.getState().setMaterial({ baseColor: '#e8e2d4', baseKind: 'kraft', overlayImage: overlay })
  await new Promise((r) => setTimeout(r, 700))
  const meshes = [...window.paperSimViewer.faceMeshes().values()]
  const mapped = meshes.length > 0 && meshes.every((m) => m.material.map !== null)
  const s = store.getState()
  const file = JSON.parse(
    JSON.stringify(
      toFoldFile(s.doc, s.angles, s.steps, s.history, s.objectRotation, s.projectName, s.material),
    ),
  )
  store.getState().loadFile(file, 'mat.fold')
  const m2 = store.getState().material
  return { mapped, kind: m2.baseKind, overlayKept: m2.overlayImage === overlay }
})

// 4. PDF exports are real PDFs with content.
out.pdf = await page.evaluate(async () => {
  const { store, dielinePDF, instructionsPDF } = window.paperSim
  const s = store.getState()
  const d = dielinePDF(s.doc, 'test')
  const i = await instructionsPDF(s.doc, s.steps, 'test')
  return {
    dielineSize: d.size,
    dielineMagic: await d.slice(0, 5).text(),
    instrSize: i ? i.size : 0,
    instrMagic: i ? await i.slice(0, 5).text() : null,
  }
})

// 5. Panels collapse to a strip and restore; sections fold shut.
await page.click('.side-panel.right .panel-toggle')
out.rightCollapsed = await page.isVisible('.side-panel.strip.right .panel-vtitle')
await page.click('.side-panel.strip.right .panel-toggle')
out.rightRestored = await page.isVisible('.side-panel.right .panel-scroll')
const firstSection = page.locator('.side-panel.left section').first()
const beforeSec = await firstSection.locator('.btn-row').count()
await page.locator('.side-panel.left .sec-head').first().click()
const afterSec = await firstSection.locator('.btn-row').count()
await page.locator('.side-panel.left .sec-head').first().click() // restore
out.sectionCollapse = { beforeSec, afterSec }

const ok =
  out.templates.names.length === 3 &&
  out.templates.reached === true &&
  out.templates.undoable === false &&
  out.templates.tuckSteps === 3 &&
  ['right side', 'back', 'left side', 'glue flap'].every((n) => out.selection.row.includes(n)) &&
  ['front roof', 'front rib', 'front bottom flap'].every((n) => out.selection.col.includes(n)) &&
  out.dblclickCount >= 5 &&
  out.tripleclickCount === out.selection.total &&
  out.material.mapped === true &&
  out.material.kind === 'kraft' &&
  out.material.overlayKept === true &&
  out.pdf.dielineMagic === '%PDF-' &&
  out.pdf.dielineSize > 1000 &&
  out.pdf.instrMagic === '%PDF-' &&
  out.pdf.instrSize > 10000 &&
  out.rightCollapsed === true &&
  out.rightRestored === true &&
  out.sectionCollapse.beforeSec > 0 &&
  out.sectionCollapse.afterSec === 0 &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
