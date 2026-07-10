// Drives a real pointer drag along the arc gizmo ring, computing the ring's
// actual screen position from the live scene (no pixel guessing).
// Dev server must be running. Usage: node scripts/verify-gizmo.mjs
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto('http://localhost:5173/')
await page.waitForFunction(() => 'paperSim' in window && 'paperSimViewer' in window)
await page.waitForTimeout(800)

// Select a non-root panel programmatically so the gizmo appears.
const hinge = await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  const child = [...s.tree.nodes.values()].find((n) => n.hingeEdgeId !== null)
  s.selectFace(child.faceId)
  return child.hingeEdgeId
})
await page.waitForTimeout(400)

/** Screen-space points around the gizmo ring in the perspective view. */
async function ringPoints() {
  return page.evaluate(() => {
    const { gizmo, views } = window.paperSimViewer
    const v = views.find((v) => v.key === 'persp')
    const rect = v.cell.getBoundingClientRect()
    gizmo.updateMatrixWorld(true)
    const V3 = gizmo.position.constructor
    const pts = []
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2
      const p = new V3(Math.cos(t), Math.sin(t), 0).applyMatrix4(gizmo.matrixWorld)
      const ndc = p.clone().project(v.camera)
      pts.push({
        x: rect.left + ((ndc.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      })
    }
    return pts
  })
}

async function dragAlongRing(fromIdx, toIdx, opts = {}) {
  const pts = await ringPoints()
  const from = pts[fromIdx]
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Follow the ring's screen path so the drag tracks the rotation plane.
  const stepDir = toIdx > fromIdx ? 1 : -1
  for (let i = fromIdx + stepDir; i !== toIdx + stepDir; i += stepDir) {
    const p = pts[((i % 64) + 64) % 64]
    await page.mouse.move(p.x, p.y)
  }
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
  await page.waitForTimeout(200)
  return page.evaluate((h) => window.paperSim.store.getState().angles[h] ?? 0, hinge)
}

// Quarter-turn along the ring → should snap to exactly ±90.
const snapped = await dragAlongRing(0, 16)
// Reset, then the same drag with Alt (free) → should NOT be a clean snap value.
await page.evaluate((h) => {
  const s = window.paperSim.store.getState()
  s.dispatch({ type: 'setAngle', edgeId: h, prev: s.angles[h] ?? 0, next: 0 })
}, hinge)
await page.waitForTimeout(300)
const free = await dragAlongRing(0, 13, { alt: true })

const history = await page.evaluate(() => {
  const h = window.paperSim.store.getState().history
  return { logLen: h.log.length, lastOp: h.log[h.log.length - 1]?.type ?? null }
})
await page.screenshot({ path: 'scripts/shots/5-gizmo-drag.png' })
console.log(
  JSON.stringify(
    {
      hinge,
      snappedDragAngle: snapped,
      snapExact: Math.abs(Math.abs(snapped) - 90) < 0.001,
      freeDragAngle: free,
      freeIsUnsnapped: ![-179, -90, 0, 90, 179].includes(free),
      history,
      pageErrors: errors,
    },
    null,
    2,
  ),
)
await browser.close()
