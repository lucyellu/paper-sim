// Visual pass for the v1 feature round: milk carton fold sequence + upright
// orientation + pattern editor with a real mouse-drawn crease.
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})
await page.goto(URL)
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)

// 1. Milk carton at 60% of targets (spout still open) — body folded fully.
await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  s.newDocument('gable')
  const st = window.paperSim.store.getState()
  const t = st.doc.targetAngles
  const angles = {}
  for (const [k, v] of Object.entries(t)) {
    // body/bottom folds complete, top gable at 60%
    angles[k] = Math.abs(v) === 90 ? v : v * 0.6
  }
  st.setAnglesTransient(angles)
  st.rotateObject('x', 90)
})
await page.waitForTimeout(700)
await page.keyboard.press('f')
await page.waitForTimeout(300)
await page.screenshot({ path: 'scripts/shots/v3-gable-open.png' })

// 2. Fully sealed at 100% targets, standing upright.
await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.setAnglesTransient({ ...st.doc.targetAngles })
})
await page.waitForTimeout(700)
await page.keyboard.press('f')
await page.waitForTimeout(300)
await page.screenshot({ path: 'scripts/shots/v3-gable-sealed.png' })

// 3. Quad view sanity with auto-centered pivot.
await page.evaluate(() => window.paperSim.store.getState().setViewLayout('quad'))
await page.waitForTimeout(500)
await page.screenshot({ path: 'scripts/shots/v3-gable-quad.png' })
await page.evaluate(() => window.paperSim.store.getState().setViewLayout('single'))

// 4. Pattern editor: open, draw a crease across the front panel with the
// mouse (vertex snap to two corners), then screenshot.
const drawn = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.newDocument('tuck')
  window.paperSim.store.getState().setEditorMode('pattern')
  return window.paperSim.store.getState().doc.faces.length
})
await page.waitForTimeout(400)
// Click "Draw crease" tool.
await page.click('.pe-toolbar button:has-text("Draw crease")')
// Compute screen positions of two front-panel corners (0,0) and (6,12).
const pts = await page.evaluate(() => {
  const svg = document.querySelector('.pattern-editor svg')
  const rect = svg.getBoundingClientRect()
  const vb = svg.viewBox.baseVal
  const scale = Math.min(rect.width / vb.width, rect.height / vb.height)
  const ox = (rect.width - vb.width * scale) / 2
  const oy = (rect.height - vb.height * scale) / 2
  const toPx = (x, y) => ({
    x: rect.left + ox + (x - vb.x) * scale,
    y: rect.top + oy + (-y - vb.y) * scale,
  })
  return [toPx(0, 0), toPx(6, 12)]
})
await page.mouse.click(pts[0].x, pts[0].y)
await page.mouse.move(pts[1].x, pts[1].y)
await page.waitForTimeout(150)
await page.mouse.click(pts[1].x, pts[1].y)
await page.waitForTimeout(300)
const after = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  return {
    faces: st.doc.faces.length,
    lastOp: st.history.log[st.history.log.length - 1]?.type,
  }
})
await page.screenshot({ path: 'scripts/shots/v3-pattern-editor.png' })

// 5. Back to 3D: the split panel should fold along the new diagonal.
await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.setEditorMode('3d')
  const doc = st.doc
  const tree = st.tree
  // fold the new diagonal hinge (edge between vertices at (0,0) and (6,12))
  const v1 = doc.vertices.find((v) => v.pos.x === 0 && v.pos.y === 0)
  const v2 = doc.vertices.find((v) => v.pos.x === 6 && v.pos.y === 12)
  const diag = doc.edges.find(
    (e) => (e.v1 === v1.id && e.v2 === v2.id) || (e.v1 === v2.id && e.v2 === v1.id),
  )
  st.dispatch({ type: 'setAngle', edgeId: diag.id, prev: 0, next: 120 })
})
await page.waitForTimeout(700)
await page.screenshot({ path: 'scripts/shots/v3-drawn-crease-folds.png' })

console.log(JSON.stringify({ facesBefore: drawn, after, errors }, null, 2))
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)
