// End-to-end: instruction sheet popup + group-fold sidebar control.
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(URL)
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)

// Milk carton with two steps: body fold, then gable to targets.
await page.evaluate(() => {
  const store = window.paperSim.store
  store.getState().newDocument('gable')
  const st = store.getState()
  const t = st.doc.targetAngles
  const body = {}
  for (const [k, v] of Object.entries(t)) if (Math.abs(v) === 90) body[k] = v
  st.setAnglesTransient(body)
  store.getState().addKeyframe()
  store.getState().setAnglesTransient({ ...t })
  store.getState().addKeyframe()
  store.getState().rotateObject('x', 90)
})
await page.waitForTimeout(500)

// The instruction sheet is printed from the File › Export… dialog.
const popupPromise = context.waitForEvent('page', { timeout: 15000 })
await page.click('.topbar .menu-label:has-text("File")')
await page.click('.menu-item:has-text("Export…")')
await page.click('[data-export="instructions-print"]')
const popup = await popupPromise
await popup.waitForLoadState('domcontentloaded')
const sheet = await popup.evaluate(() => ({
  title: document.title,
  images: document.querySelectorAll('.step img').length,
  svg: !!document.querySelector('.dieline svg'),
}))
await popup.screenshot({ path: 'scripts/shots/v3-instruction-sheet.png', fullPage: true })
await popup.close()
await page.click('.export-modal button:has-text("Done")')

// Group fold UI: ctrl-click two gusset panels, press "To target".
const group = await page.evaluate(() => {
  const store = window.paperSim.store
  const st = store.getState()
  st.setAnglesTransient(
    Object.fromEntries(Object.keys(st.doc.targetAngles).map((k) => [k, 0])),
  )
  const g1 = st.doc.faces.find((f) => f.name === 'right side gusset')
  const g2 = st.doc.faces.find((f) => f.name === 'right side gusset left')
  const g3 = st.doc.faces.find((f) => f.name === 'right side gusset right')
  st.selectFace(g1.id)
  st.selectFace(g2.id, true)
  st.selectFace(g3.id, true)
  return store.getState().selection.length
})
await page.waitForTimeout(200)
const hasGroupUI = await page.isVisible('button:has-text("To target")')
if (hasGroupUI) await page.click('button:has-text("To target")')
await page.waitForTimeout(300)
const groupAngles = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  const names = ['right side gusset', 'right side gusset left', 'right side gusset right']
  return names.map((n) => {
    const f = st.doc.faces.find((f) => f.name === n)
    const h = st.tree.nodes.get(f.id).hingeEdgeId
    return { angle: st.angles[h], target: st.doc.targetAngles[h] }
  })
})
await page.screenshot({ path: 'scripts/shots/v3-group-fold.png' })

console.log(JSON.stringify({ sheet, group, hasGroupUI, groupAngles, errors }, null, 2))
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)
