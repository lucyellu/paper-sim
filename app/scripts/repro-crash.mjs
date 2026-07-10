// Stress repro: mimic the user's session that ended in a crash —
// fold body + flaps, add keyframes, re-edit steps mid-sequence, history
// surgery, scrub/play — and report any page errors.
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch()
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console: ' + m.text())
})
await page.goto(URL)
await page.waitForFunction(() => window.paperSim)

const result = await page.evaluate(async () => {
  const store = window.paperSim.store
  const out = { phases: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const s = () => store.getState()

  function foldByName(name, deg) {
    const st = s()
    const face = st.doc.faces.find((f) => f.name === name)
    if (!face) throw new Error('no face ' + name)
    const node = st.tree.nodes.get(face.id)
    const edgeId = node.hingeEdgeId
    const prev = st.angles[edgeId] ?? 0
    st.selectFace(face.id)
    st.dispatch({ type: 'setAngle', edgeId, prev, next: deg })
  }

  try {
    // Phase 1: body folds + keyframes (like the user's steps 1-3)
    foldByName('back', 90)
    s().addKeyframe()
    foldByName('left side', 124)
    foldByName('left side', 90)
    s().addKeyframe()
    foldByName('front bottom flap', 96)
    foldByName('front bottom flap', 90)
    foldByName('right side bottom flap', 97.1)
    s().addKeyframe()
    out.phases.push('folds+keyframes ok, steps=' + s().steps.length)

    // Phase 2: re-edit mid sequence like the history shows
    s().editStepInPlace(2)
    s().addKeyframe()
    s().editFromStep(1)
    foldByName('right side', 81)
    foldByName('right side', 90)
    s().addKeyframe()
    out.phases.push('re-edit ok, steps=' + s().steps.length)

    // Phase 3: fold the top closure area
    foldByName('front top flap', 24)
    foldByName('front top flap', 90)
    foldByName('back top flap', 90)
    foldByName('right side top flap', 90)
    foldByName('left side top flap', 90)
    foldByName('glue flap', 90)
    s().addKeyframe()
    out.phases.push('top closure ok, steps=' + s().steps.length)

    // Phase 4: scrub + play
    s().setScrub(1.5)
    await sleep(100)
    s().setPlaying(true)
    await sleep(600)
    s().setPlaying(false)
    s().enterEditMode()
    out.phases.push('scrub ok')

    // Phase 5: history surgery — delete single ops incl. an addStep
    const log = s().history.log
    const addStepIdx = log.findIndex((op) => op.type === 'addStep')
    s().deleteOpAt(addStepIdx)
    await sleep(50)
    s().deleteNonDeformerOps()
    await sleep(50)
    out.phases.push('surgery ok, steps=' + s().steps.length + ' log=' + s().history.log.length)

    // Phase 6: revert cursor around, undo/redo spam
    s().revertToCursor(2)
    s().revertToCursor(s().history.log.length)
    for (let i = 0; i < 30; i++) s().undo()
    for (let i = 0; i < 30; i++) s().redo()
    out.phases.push('undo/redo ok')

    // Phase 7: extreme angles on stacked flaps
    foldByName('front top flap', 179)
    foldByName('back top flap', -179)
    foldByName('front top flap', 0)
    out.phases.push('extremes ok')
  } catch (e) {
    out.thrown = String(e && e.stack ? e.stack : e)
  }
  return out
})

await new Promise((r) => setTimeout(r, 500))
console.log(JSON.stringify({ result, pageErrors }, null, 2))
await browser.close()
