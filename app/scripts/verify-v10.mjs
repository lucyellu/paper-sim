// Verifies the "Mode menu + UV editor" round:
//  - Top-menu Mode switches Fold / UV / Instructions workspaces; UV mode shows
//    the UV editor, Instructions mode shows the sheet preview with one card
//    per step (+ the flat start).
//  - Per-face UV edits: applyFaceUV math (translate + 90° rotation), save/load
//    round-trip via paperSim:uvEdits, pruning of identity entries.
//  - Print fidelity: buildPrintCanvas inverse-warps the artwork per edited
//    face, so a du=0.5 shift makes the face's dieline region print the pixels
//    its UVs now sample in 3D.
//  - bakeMesh carries UV edits into exported mesh UVs.
//  - Dragging an island in the UV editor translates its UVs and selects it.
// Usage: node scripts/verify-v10.mjs   (dev server must be running)
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
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

// ---- 1. Logic: UV math, print warp, mesh bake, save/load ---------------------
const out = await page.evaluate(async () => {
  const P = window.paperSim
  const { store } = P
  const r = {}
  const near = (a, b, tol) => Math.abs(a - b) <= tol

  // applyFaceUV: translate, and 90° (clockwise-on-screen) rotation about the centroid.
  const square = {
    vertices: [
      { id: 0, pos: { x: 0, y: 0 } },
      { id: 1, pos: { x: 10, y: 0 } },
      { id: 2, pos: { x: 10, y: 10 } },
      { id: 3, pos: { x: 0, y: 10 } },
    ],
    edges: [
      { id: 10, v1: 0, v2: 1, kind: 'cut' },
      { id: 11, v1: 1, v2: 2, kind: 'cut' },
      { id: 12, v1: 2, v2: 3, kind: 'cut' },
      { id: 13, v1: 3, v2: 0, kind: 'cut' },
    ],
    faces: [{ id: 20, name: 'sheet', vertexIds: [0, 1, 2, 3] }],
    rootFaceId: 20,
  }
  const face = square.faces[0]
  const c = P.faceUVCentroid(square, face) // (0.5, 0.5)
  const shift = { ...P.identityFaceUV(), du: 0.25 }
  const [tu, tv] = P.applyFaceUV(shift, c, 0.5, 0.5)
  const rot90 = { ...P.identityFaceUV(), rotationDeg: 90 }
  // Point straight "up" from the centroid must land to the RIGHT (clockwise).
  const [ru, rv] = P.applyFaceUV(rot90, c, 0.5, 0.75)
  r.math = { c, tu, tv, ru, rv }
  r.mathOk =
    near(c.u, 0.5, 1e-9) &&
    near(tu, 0.75, 1e-9) &&
    near(tv, 0.5, 1e-9) &&
    near(ru, 0.75, 1e-9) &&
    near(rv, 0.5, 1e-9)

  // Print warp: artwork = left half red, right half blue. Shift the face's UVs
  // right by 0.5 -> the LEFT half of the printed sheet must now show BLUE
  // (the pixels the face samples in 3D).
  const art = document.createElement('canvas')
  art.width = 200
  art.height = 200
  const actx = art.getContext('2d')
  actx.fillStyle = '#ff0000'
  actx.fillRect(0, 0, 100, 200)
  actx.fillStyle = '#0000ff'
  actx.fillRect(100, 0, 100, 200)
  const material = {
    baseColor: '#d9bc8d',
    baseKind: 'color',
    overlayImage: art.toDataURL('image/png'),
  }
  const half = { ...P.identityFaceUV(), du: 0.5 }
  const plain = await P.buildPrintCanvas(square, material, {})
  const warped = await P.buildPrintCanvas(square, material, { 20: half })
  const px = (canvas, fx, fy) =>
    [...canvas
      .getContext('2d')
      .getImageData(Math.round(canvas.width * fx), Math.round(canvas.height * fy), 1, 1).data]
  const plainLeft = px(plain, 0.25, 0.5) // red
  const warpLeft = px(warped, 0.25, 0.5) // should be blue after the shift
  const warpRight = px(warped, 0.75, 0.5) // out of artwork -> base color fill
  r.print = { plainLeft, warpLeft, warpRight }
  r.printOk =
    plainLeft[0] > 200 && plainLeft[2] < 60 && // red before
    warpLeft[2] > 200 && warpLeft[0] < 60 && // blue after
    warpRight[0] > 150 // base paper color (not blue)

  // bakeMesh carries the edit into exported UVs.
  const tree = P.buildPanelTree(square)
  const base = P.bakeMesh(square, tree, {}, 'flat')
  const baked = P.bakeMesh(square, tree, {}, 'flat', { 20: half })
  r.mesh = { u0: base.uvs[0], u0Shift: baked.uvs[0] }
  r.meshOk = near(baked.uvs[0] - base.uvs[0], 0.5, 1e-9)

  // Store + save/load round-trip; identity entries prune away.
  store.getState().newDocument('gable', { width: 5, depth: 3.2, height: 13 })
  let st = store.getState()
  const fid = st.doc.faces[0].id
  const otherFid = st.doc.faces[1].id
  st.setUVEdits({
    [fid]: { du: 0.12, dv: -0.04, rotationDeg: 90, scaleU: 1, scaleV: 1 },
    [otherFid]: P.identityFaceUV(), // must prune
  })
  st = store.getState()
  r.prune = Object.keys(st.uvEdits)
  const file = P.toFoldFile(
    st.doc, st.angles, st.steps, st.history, st.transform, st.projectName, st.material, st.uvEdits,
  )
  const loaded = P.fromFoldFile(JSON.parse(JSON.stringify(file)))
  r.roundTrip = loaded.uvEdits
  r.storeOk =
    Object.keys(st.uvEdits).length === 1 &&
    near(loaded.uvEdits[fid]?.du, 0.12, 1e-9) &&
    near(loaded.uvEdits[fid]?.dv, -0.04, 1e-9) &&
    near(loaded.uvEdits[fid]?.rotationDeg, 90, 1e-9) &&
    file['paperSim:uvEdits'] !== undefined

  // A file with no edits omits the field entirely.
  st.setUVEdits({})
  const clean = P.toFoldFile(
    st.doc, st.angles, st.steps, st.history, st.transform, st.projectName, st.material,
    store.getState().uvEdits,
  )
  r.cleanOk = clean['paperSim:uvEdits'] === undefined

  return r
})

// ---- 2. UI: Mode menu switches workspaces ------------------------------------
await page.click('.topbar .menu-label:has-text("Mode")')
await page.click('.menu-item:has-text("UV mode")')
const uvVisible = await page.locator('.uv-editor').count()
const uvIslands = await page.locator('.uv-editor polygon[data-faceid]').count()

// ---- 3. UI: drag an island -> selection + translated UVs + ONE undoable op ----
const island = page.locator('.uv-editor polygon[data-faceid]').first()
const islandId = Number(await island.getAttribute('data-faceid'))
const box = await island.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 25, { steps: 8 })
await page.mouse.up()
const dragResult = await page.evaluate((id) => {
  const st = window.paperSim.store.getState()
  const log = st.history.log
  const top = log[log.length - 1]
  const before = st.uvEdits[id] ?? null
  st.undo()
  const afterUndo = window.paperSim.store.getState().uvEdits[id] ?? null
  window.paperSim.store.getState().redo()
  const afterRedo = window.paperSim.store.getState().uvEdits[id] ?? null
  return {
    selected: st.selection.includes(id),
    edit: before,
    topOp: top?.type,
    undoCleared: afterUndo === null,
    redoRestored: !!afterRedo && Math.abs(afterRedo.du - before.du) < 1e-9,
  }
}, islandId)

// ---- 3b. UI: TYPING "0.6" into a scale field works (the field used to snap
// back to 1 on the intermediate keystrokes) and scales the multi-selection as
// ONE piece about its center (not each island separately) ----------------------
await page.evaluate(() => window.paperSim.store.getState().newDocument('tuck'))
await page.click('.topbar .menu-label:has-text("Mode")')
await page.click('.menu-item:has-text("UV mode")')
await page.click('.pe-toolbar button:has-text("Select all")')
const scaleVInput = page.locator('.uv-editor .tex-grid').first().locator('input').nth(4)
await scaleVInput.click()
await scaleVInput.press('Control+a')
await page.keyboard.type('0.6', { delay: 40 }) // char-by-char, like a human
await scaleVInput.press('Enter')
const groupScale = await page.evaluate(() => {
  const P = window.paperSim
  const st = P.store.getState()
  const ed = (id) => st.uvEdits[id] ?? P.identityFaceUV()
  const base = (f) => P.faceUVCentroid(st.doc, f)
  const center = (f) => {
    const c = base(f)
    const t = ed(f.id)
    return { u: c.u + t.du, v: c.v + t.dv }
  }
  // Two panels far apart vertically: their island centers must close in by
  // exactly the scale factor along v, and stay put along u.
  let a = st.doc.faces[0]
  let b = st.doc.faces[0]
  for (const f of st.doc.faces) {
    if (base(f).v < base(a).v) a = f
    if (base(f).v > base(b).v) b = f
  }
  const ratioV = (center(b).v - center(a).v) / (base(b).v - base(a).v)
  const ratioU = Math.abs(center(b).u - center(a).u - (base(b).u - base(a).u))
  return { ratioV, ratioU, scaleV: ed(a.id).scaleV, scaleU: ed(a.id).scaleU }
})
const groupOk =
  Math.abs(groupScale.ratioV - 0.6) < 1e-6 &&
  groupScale.ratioU < 1e-6 &&
  Math.abs(groupScale.scaleV - 0.6) < 1e-9 &&
  Math.abs(groupScale.scaleU - 1) < 1e-9

// ---- 3c. UI: in-scene gizmo — drag the scale handle to grow the selection -----
const gizmoCount = await page.locator('.uv-gizmo').count()
const scaleUBefore = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  return (st.uvEdits[st.doc.faces[0].id] ?? window.paperSim.identityFaceUV()).scaleU
})
const pivotBox = await page.locator('[data-uvgizmo="move"]').boundingBox()
const handleBox = await page.locator('[data-uvgizmo="scale"]').boundingBox()
const hx = handleBox.x + handleBox.width / 2
const hy = handleBox.y + handleBox.height / 2
const px2 = pivotBox.x + pivotBox.width / 2
const py2 = pivotBox.y + pivotBox.height / 2
await page.mouse.move(hx, hy)
await page.mouse.down()
// Pull the handle to ~1.5x its distance from the pivot.
await page.mouse.move(px2 + (hx - px2) * 1.5, py2 + (hy - py2) * 1.5, { steps: 6 })
await page.mouse.up()
const gizmoScale = await page.evaluate((before) => {
  const st = window.paperSim.store.getState()
  const t = st.uvEdits[st.doc.faces[0].id] ?? window.paperSim.identityFaceUV()
  const top = st.history.log[st.history.log.length - 1]
  return { before, after: t.scaleU, topOp: top?.type, topLabel: top?.label }
}, scaleUBefore)
const gizmoOk =
  gizmoCount === 1 &&
  gizmoScale.after > gizmoScale.before * 1.2 &&
  gizmoScale.topOp === 'setUVs' &&
  gizmoScale.topLabel === 'scale islands'

// ---- 3d. UI: Geometry mode — dragging an island moves the dieline itself,
// as one undoable setDoc op ------------------------------------------------------
await page.click('.pe-toolbar button:has-text("Reset all")')
await page.click('.pe-toolbar button:has-text("Geometry")')
const geoBefore = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  const f = st.doc.faces[0]
  const v = st.doc.vertices.find((x) => x.id === f.vertexIds[0])
  return { faceId: f.id, vid: v.id, x: v.pos.x, y: v.pos.y, uvCount: Object.keys(st.uvEdits).length }
})
const geoIsland = page.locator(`.uv-editor polygon[data-faceid="${geoBefore.faceId}"]`)
const gb = await geoIsland.boundingBox()
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
await page.mouse.down()
await page.mouse.move(gb.x + gb.width / 2 + 50, gb.y + gb.height / 2, { steps: 6 })
await page.mouse.up()
const geoResult = await page.evaluate((before) => {
  const st = window.paperSim.store.getState()
  const v = st.doc.vertices.find((x) => x.id === before.vid)
  const top = st.history.log[st.history.log.length - 1]
  const movedX = v.pos.x - before.x
  st.undo()
  const v2 = window.paperSim.store.getState().doc.vertices.find((x) => x.id === before.vid)
  return {
    movedX,
    uvUntouched: Object.keys(st.uvEdits).length === before.uvCount,
    topOp: top?.type,
    topLabel: top?.label,
    undoRestored: Math.abs(v2.pos.x - before.x) < 1e-9,
  }
}, geoBefore)
const geoOk =
  geoResult.movedX > 0.5 &&
  geoResult.uvUntouched === true &&
  geoResult.topOp === 'setDoc' &&
  /UV geometry/.test(geoResult.topLabel ?? '') &&
  geoResult.undoRestored === true
await page.click('.pe-toolbar button:has-text("Geometry")') // back to UV mode

// ---- 3e. UI: Artwork section — numeric edit commits an op; Auto-fit detects
// the content box (margins trimmed) ----------------------------------------------
await page.evaluate(() => {
  // Artwork with big margins: content fills only the middle half.
  const art = document.createElement('canvas')
  art.width = 200
  art.height = 200
  const ctx = art.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 200, 200)
  ctx.fillStyle = '#2255cc'
  ctx.fillRect(50, 50, 100, 100)
  const st = window.paperSim.store.getState()
  st.setMaterial({ ...st.material, overlayImage: art.toDataURL('image/png') })
})
const artInput = page.locator('.uv-editor .tex-grid').nth(1).locator('input').first()
await artInput.click()
await artInput.press('Control+a')
await page.keyboard.type('0.2', { delay: 30 })
await artInput.press('Enter')
const artField = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  const top = st.history.log[st.history.log.length - 1]
  return { offsetX: st.material.overlayTransform?.offsetX, topOp: top?.type }
})
await page.click('.pe-inspector button:has-text("Auto-fit")')
await page.waitForFunction(
  () => Math.abs((window.paperSim.store.getState().material.overlayTransform?.scaleX ?? 1) - 1) > 0.3,
)
const autoFit = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  const top = st.history.log[st.history.log.length - 1]
  const ov = st.material.overlayTransform
  st.undo()
  const back = window.paperSim.store.getState().material.overlayTransform
  return { scaleX: ov?.scaleX, topOp: top?.type, undoOffsetX: back?.offsetX }
})
const artOk =
  Math.abs((artField.offsetX ?? 0) - 0.2) < 1e-9 &&
  artField.topOp === 'setOverlay' &&
  (autoFit.scaleX ?? 1) > 1.5 &&
  autoFit.topOp === 'setOverlay' &&
  Math.abs((autoFit.undoOffsetX ?? 0) - 0.2) < 1e-9

// ---- 4. UI: Instructions mode shows one card per step (+ start) ---------------
await page.click('.topbar .menu-label:has-text("Mode")')
await page.click('.menu-item:has-text("Instructions mode")')
await page.waitForTimeout(600)
const ivVisible = await page.locator('.instructions-view').count()
const stepCount = await page.evaluate(() => window.paperSim.store.getState().steps.length)
const cardCount = await page.locator('.instructions-view .iv-step img').count()

// Back to fold mode: the timeline returns.
await page.click('.topbar .menu-label:has-text("Mode")')
await page.click('.menu-item:has-text("Fold mode")')
const foldBack = await page.evaluate(
  () => window.paperSim.store.getState().workspaceMode === 'fold',
)

const ui = {
  uvVisible,
  uvIslands,
  islandId,
  dragResult,
  groupScale,
  groupOk,
  gizmoScale,
  gizmoOk,
  geoResult,
  geoOk,
  artField,
  autoFit,
  artOk,
  ivVisible,
  stepCount,
  cardCount,
  foldBack,
}
const uiOk =
  uvVisible === 1 &&
  uvIslands > 5 &&
  dragResult.selected === true &&
  dragResult.edit !== null &&
  Math.abs(dragResult.edit.du) > 0.005 &&
  dragResult.topOp === 'setUVs' &&
  dragResult.undoCleared === true &&
  dragResult.redoRestored === true &&
  groupOk &&
  gizmoOk &&
  geoOk &&
  artOk &&
  ivVisible === 1 &&
  cardCount === stepCount + 1 &&
  foldBack === true

const ok =
  out.mathOk === true &&
  out.printOk === true &&
  out.meshOk === true &&
  out.storeOk === true &&
  out.cleanOk === true &&
  uiOk &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, ui, uiOk, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
