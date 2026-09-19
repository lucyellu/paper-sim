// Verifies the top-bar cleanup: File › New… and File › Export… open dialogs.
//  - The menu bar is File / Edit / Mode (no separate Export menu, no "New — …" items).
//  - New dialog: every template card has a dieline thumbnail and builds its template.
//  - Export dialog: format / artwork / pose toggles drive the downloaded file;
//    Escape and "Done" close it.
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.goto(URL)
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)

async function fileMenu(item) {
  await page.click('.topbar .menu-label:has-text("File")')
  await page.click(`.menu-item:has-text("${item}")`)
}

// ---- 1. Menu bar shape -----------------------------------------------------
const menus = await page.locator('.topbar .menu-label').allTextContents()
await page.click('.topbar .menu-label:has-text("File")')
const fileItems = await page.locator('.menu-item').allTextContents()
await page.screenshot({ path: 'scripts/shots/v14-file-menu.png', clip: { x: 0, y: 0, width: 420, height: 320 } })
await page.click('.topbar .menu-label:has-text("File")')
const menuOk =
  menus.join('|') === 'File|Edit|Mode' &&
  fileItems.includes('New…') &&
  fileItems.includes('Export…') &&
  !fileItems.some((t) => t.startsWith('New —'))

// ---- 2. New dialog ---------------------------------------------------------
await fileMenu('New…')
await page.waitForSelector('.new-modal')
await page.waitForFunction(() =>
  [...document.querySelectorAll('.new-card img')].every((i) => i.complete && i.naturalWidth > 0),
)
await page.screenshot({ path: 'scripts/shots/v14-new-dialog.png' })
const cardIds = await page.locator('.new-card').evaluateAll((els) => els.map((e) => e.dataset.template))
await page.keyboard.press('Escape')
const newClosesOnEsc = (await page.locator('.new-modal').count()) === 0

const built = {}
for (const id of cardIds) {
  await fileMenu('New…')
  await page.click(`.new-card[data-template="${id}"]`)
  await page.click('.new-modal button.primary')
  await page.waitForSelector('.new-modal', { state: 'detached' })
  built[id] = await page.evaluate(() => {
    const s = window.paperSim.store.getState()
    const xs = s.doc.vertices.map((v) => v.pos.x)
    const ys = s.doc.vertices.map((v) => v.pos.y)
    const size = `${(Math.max(...xs) - Math.min(...xs)).toFixed(2)}x${(Math.max(...ys) - Math.min(...ys)).toFixed(2)}`
    // Geometry fingerprint: every template/preset must build a different dieline.
    const sig = `${s.doc.faces.length}:${s.doc.edges.length}:${size}:${s.doc.vertices.map((v) => v.pos.x.toFixed(2)).join(',')}`
    return { faces: s.doc.faces.length, size, steps: s.steps.length, name: s.projectName, sig }
  })
}
// Double-click a card creates immediately.
await fileMenu('New…')
await page.dblclick('.new-card[data-template="milk-1l"]')
await page.waitForSelector('.new-modal', { state: 'detached' })
const dblName = await page.evaluate(() => window.paperSim.store.getState().projectName)
const distinct = new Set(Object.values(built).map((b) => b.sig)).size
for (const b of Object.values(built)) delete b.sig
const newOk =
  cardIds.length === 8 &&
  newClosesOnEsc &&
  Object.values(built).every((b) => b.faces > 0) &&
  distinct === cardIds.length &&
  dblName === 'milk carton'

// ---- 3. Export dialog ------------------------------------------------------
await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.setAnglesTransient({ ...st.doc.targetAngles })
  window.paperSim.store.getState().addKeyframe()
})
await fileMenu('Export…')
await page.waitForSelector('.export-modal')
await page.screenshot({ path: 'scripts/shots/v14-export-dialog.png' })

async function download(action) {
  const dl = page.waitForEvent('download', { timeout: 20000 })
  await action()
  const d = await dl
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) }
}
const seg = (name, value) => page.click(`[data-seg="${name}"] [data-value="${value}"]`)

await seg('dieline-format', 'pdf-1to1')
const pdf11 = await download(() => page.click('[data-export="dieline"]'))
await seg('dieline-format', 'png')
const pngArtLocked = await page.locator('[data-testid="export-art"]').evaluate((el) => el.disabled && el.checked)
const png = await download(() => page.click('[data-export="dieline"]'))
await seg('mesh-format', 'obj')
await seg('mesh-pose', 'flat')
const obj = await download(() => page.click('[data-export="mesh"]'))
await seg('mesh-format', 'glb')
await seg('mesh-pose', 'folded')
const glb = await download(() => page.click('[data-export="mesh"]'))
const status = await page.locator('[data-testid="export-status"]').textContent()
await page.click('.export-modal button:has-text("Done")')
const exportClosed = (await page.locator('.export-modal').count()) === 0

// Choices are remembered on reopen.
await fileMenu('Export…')
const remembered = await page.evaluate(() => ({
  dieline: document.querySelector('[data-seg="dieline-format"] .active')?.dataset.value,
  mesh: document.querySelector('[data-seg="mesh-format"] .active')?.dataset.value,
}))
await page.keyboard.press('Escape')
const exportEsc = (await page.locator('.export-modal').count()) === 0

const exportOk =
  pdf11.name.includes('dieline_1to1') &&
  pdf11.bytes.slice(0, 5).toString() === '%PDF-' &&
  pngArtLocked &&
  png.name.endsWith('.png') &&
  png.bytes.readUInt32BE(0) === 0x89504e47 &&
  obj.name.includes('obj_flat') && obj.name.endsWith('.zip')
const meshOk = glb.name.endsWith('.glb') && glb.bytes.slice(0, 4).toString() === 'glTF'

const result = {
  menus,
  fileItems,
  menuOk,
  cardIds,
  built,
  dblName,
  newOk,
  downloads: [pdf11.name, png.name, obj.name, glb.name],
  pngArtLocked,
  status,
  exportClosed,
  remembered,
  exportEsc,
  exportOk,
  meshOk,
  pageErrors,
}
result.ok =
  menuOk &&
  newOk &&
  exportOk &&
  meshOk &&
  exportClosed &&
  exportEsc &&
  remembered.dieline === 'png' &&
  remembered.mesh === 'glb' &&
  pageErrors.length === 0
console.log(JSON.stringify(result, null, 2))
await browser.close()
process.exit(result.ok ? 0 : 1)
