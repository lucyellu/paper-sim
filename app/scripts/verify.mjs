// Smoke-drives the running dev server (npm run dev) through the core v0 flows
// using the dev-only window.paperSim handle. Usage: node scripts/verify.mjs
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const SHOTS = process.env.SHOT_DIR ?? 'scripts/shots'
import { mkdirSync } from 'node:fs'
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

await page.goto(URL)
await page.waitForFunction(() => 'paperSim' in window)
await page.waitForTimeout(800)
await page.screenshot({ path: `${SHOTS}/1-flat.png` })

// --- selection via real click on the canvas -------------------------------
await page.mouse.click(940, 470)
await page.waitForTimeout(300)
const selection = await page.evaluate(() => {
  const s = window.paperSim.store.getState()
  const face = s.doc.faces.find((f) => f.id === s.selectedFaceId)
  return { selectedFaceId: s.selectedFaceId, name: face?.name ?? null }
})
await page.screenshot({ path: `${SHOTS}/2-selected.png` })

// --- fold the carton, record keyframes, undo/redo, save/load --------------
const results = await page.evaluate(() => {
  const { store, toFoldFile } = window.paperSim
  const out = {}
  const s0 = store.getState()
  out.faces = s0.doc.faces.length
  out.hinges = s0.tree.hingeEdgeIds.length

  const vertical = []
  const horizontal = []
  for (const node of s0.tree.nodes.values()) {
    if (node.hingeEdgeId === null) continue
    if (Math.abs(node.axisA.x - node.axisB.x) < 1e-6) vertical.push(node.hingeEdgeId)
    else horizontal.push(node.hingeEdgeId)
  }
  out.verticalHinges = vertical.length // body creases + glue flap = 4
  out.horizontalHinges = horizontal.length // 8 flaps

  const setAngle = (edgeId, next) => {
    const prev = store.getState().angles[edgeId] ?? 0
    store.getState().dispatch({ type: 'setAngle', edgeId, prev, next })
  }

  // Step 1: fold the tube (vertical creases to 90).
  for (const e of vertical) setAngle(e, 90)
  store.getState().addKeyframe()
  // Step 2: close the flaps.
  for (const e of horizontal) setAngle(e, 90)
  store.getState().addKeyframe()

  let s = store.getState()
  out.steps = s.steps.length // 2
  out.logLen = s.history.log.length // 12 setAngle + 2 addStep = 14

  // Undo/redo.
  s.undo()
  out.stepsAfterUndo = store.getState().steps.length // 1
  store.getState().redo()
  out.stepsAfterRedo = store.getState().steps.length // 2

  // Rename + truncate ops.
  s = store.getState()
  s.renameStep(s.steps[0].id, 'Fold the tube')
  out.renamed = store.getState().steps[0].name

  // Save → load round trip (history must survive).
  s = store.getState()
  const anglesBefore = JSON.stringify(s.angles)
  const file = JSON.parse(JSON.stringify(toFoldFile(s.doc, s.angles, s.steps, s.history)))
  out.fileHasFoldFields =
    Array.isArray(file.vertices_coords) && Array.isArray(file.edges_assignment)
  store.getState().loadFile(file, 'roundtrip.fold')
  const s2 = store.getState()
  out.roundtripSteps = s2.steps.length // 2
  out.roundtripAnglesMatch = JSON.stringify(s2.angles) === anglesBefore
  out.canUndoAfterLoad = s2.history.cursor > 0 // THE feature

  // Undo after load: rename should revert.
  s2.undo()
  out.nameAfterLoadUndo = store.getState().steps[0].name // 'Step 1'
  store.getState().redo()
  out.nameAfterLoadRedo = store.getState().steps[0].name // 'Fold the tube'

  // Playback scrub.
  store.getState().setScrub(1)
  out.scrubMode = store.getState().playback.mode

  // Delete History bake.
  store.getState().enterEditMode()
  store.getState().deleteHistory()
  const s3 = store.getState()
  out.logAfterBake = s3.history.log.length // 0
  out.stepsAfterBake = s3.steps.length // 2 (state kept)

  return out
})

await page.waitForTimeout(400)
await page.screenshot({ path: `${SHOTS}/3-folded.png` })

// Scrub halfway through step 1 for a mid-fold screenshot.
await page.evaluate(() => window.paperSim.store.getState().setScrub(0.5))
await page.waitForTimeout(300)
await page.screenshot({ path: `${SHOTS}/4-midfold.png` })

console.log(JSON.stringify({ selection, results, pageErrors: errors }, null, 2))
await browser.close()
