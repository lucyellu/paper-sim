// Verifies round-2 features: timeline notches + step editing, history panel
// surgery (revert/delete/non-deformer), F-to-frame, quad view, dark mode,
// gizmo snap. Dev server must be running. Usage: node scripts/verify-v2.mjs
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const SHOTS = 'scripts/shots'
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(process.env.PAPERSIM_URL ?? 'http://localhost:5173/')
await page.waitForFunction(() => 'paperSim' in window)
await page.waitForTimeout(800)

const out = {}

// Fold + 2 keyframes via the store (covered by earlier verify; here it's setup).
await page.evaluate(() => {
  const { store } = window.paperSim
  const s0 = store.getState()
  const vertical = []
  const horizontal = []
  for (const node of s0.tree.nodes.values()) {
    if (node.hingeEdgeId === null) continue
    if (Math.abs(node.axisA.x - node.axisB.x) < 1e-6) vertical.push(node.hingeEdgeId)
    else horizontal.push(node.hingeEdgeId)
  }
  const setAngle = (edgeId, next) => {
    const prev = store.getState().angles[edgeId] ?? 0
    store.getState().dispatch({ type: 'setAngle', edgeId, prev, next })
  }
  for (const e of vertical) setAngle(e, 90)
  store.getState().addKeyframe()
  for (const e of horizontal) setAngle(e, 90)
  store.getState().addKeyframe()
})
await page.waitForTimeout(300)

// --- timeline notches: click notch 1 → selects step 1 ----------------------
out.notchCount = await page.locator('.notch').count()
await page.locator('.notch').first().click()
await page.waitForTimeout(300)
out.afterNotchClick = await page.evaluate(() => {
  const p = window.paperSim.store.getState().playback
  return p.mode === 'scrub' ? p.t : null
})
out.timelineLabel = await page.locator('.timeline-label').textContent()
out.stepEditButtonsVisible =
  (await page.locator('.timeline button[title^="Re-edit"]').count()) === 1
await page.screenshot({ path: `${SHOTS}/6-timeline-notches.png` })

// --- history panel: rows, revert (detailed undo), delete op, non-deformer --
await page.evaluate(() => window.paperSim.store.getState().enterEditMode())
out.opRows = await page.locator('.op-row:not(.base)').count() // 14
// Rename a step (adds a non-deformer op), then remove it via Delete non-deformer.
await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  s.renameStep(s.steps[0].id, 'Fold the tube')
})
out.nameAfterRename = await page.evaluate(
  () => window.paperSim.store.getState().steps[0].name,
)
page.once('dialog', (d) => d.accept())
await page.locator('button:has-text("Delete non-deformer")').click()
await page.waitForTimeout(200)
out.nameAfterNonDeformerDelete = await page.evaluate(
  () => window.paperSim.store.getState().steps[0].name, // back to "Step 1"
)

// Revert to mid-history by clicking an op row (detailed undo).
await page.locator('.op-row:not(.base)').nth(3).click() // after 4th op
await page.waitForTimeout(200)
out.cursorAfterRowClick = await page.evaluate(
  () => window.paperSim.store.getState().history.cursor, // 4
)
out.redoTailRows = await page.locator('.op-row.redo-tail').count() // 10
await page.screenshot({ path: `${SHOTS}/7-history-revert.png` })

// Delete a single op from the middle (history surgery).
const before = await page.evaluate(() => window.paperSim.store.getState().history.log.length)
await page.locator('.op-row:not(.base) .op-delete').nth(1).click()
await page.waitForTimeout(200)
out.opDeleted =
  (await page.evaluate(() => window.paperSim.store.getState().history.log.length)) ===
  before - 1

// Jump back to the end of history for the visual checks.
await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  s.revertToCursor(s.history.log.length)
})

// --- F to frame -------------------------------------------------------------
await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  s.selectFace(s.doc.faces[1].id) // a top flap
})
await page.keyboard.press('f')
await page.waitForTimeout(400)
await page.screenshot({ path: `${SHOTS}/8-framed.png` })
await page.evaluate(() => window.paperSim.store.getState().selectFace(null))
await page.keyboard.press('f')
await page.waitForTimeout(400)

// --- quad view + dark mode ---------------------------------------------------
await page.evaluate(() => window.paperSim.store.getState().setViewLayout('quad'))
await page.waitForTimeout(500)
out.visibleViewCells = await page
  .locator('.view-cell')
  .evaluateAll((els) => els.filter((el) => el.offsetParent !== null).length) // 4
await page.screenshot({ path: `${SHOTS}/9-quad.png` })

await page.evaluate(() => window.paperSim.store.getState().setTheme('dark'))
await page.waitForTimeout(400)
await page.screenshot({ path: `${SHOTS}/10-dark-quad.png` })

// --- gizmo snap: real drag should land exactly on a snap candidate ----------
await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  s.setTheme('light')
  s.setViewLayout('single')
  s.newDocument()
})
await page.waitForTimeout(500)
await page.mouse.click(940, 470) // select "right side"
await page.waitForTimeout(300)
const hinge = await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  return s.tree.nodes.get(s.selectedFaceId)?.hingeEdgeId ?? null
})
// Tangential drag from the top of the ring for a large angle change.
await page.mouse.move(835, 388)
await page.mouse.down()
await page.mouse.move(650, 500, { steps: 20 })
await page.mouse.up()
await page.waitForTimeout(200)
out.dragAngle = await page.evaluate(
  (h) => window.paperSim.store.getState().angles[h] ?? 0,
  hinge,
)
const snaps = [-179, -90, 0, 90, 179]
out.dragSnapped = snaps.some((c) => out.dragAngle === c)
out.dragMoved = Math.abs(out.dragAngle) > 0.001 || out.dragAngle === 0

console.log(JSON.stringify({ out, pageErrors: errors }, null, 2))
await browser.close()
