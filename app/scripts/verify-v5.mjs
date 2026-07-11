// Verifies the v1.5 round: transform state (move/rotate/scale + persistence),
// select modes + edge-ring selection, axis-constrained edge-ring reshape, mesh
// export (OBJ/FBX bytes + bake), and the UV overlay transform round-trip.
// Usage: node scripts/verify-v5.mjs   (dev server must be running)
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
await page.waitForTimeout(600)

const out = await page.evaluate(() => {
  const P = window.paperSim
  const { store } = P
  const r = {}

  // ---- 0. new gable carton -------------------------------------------------
  store.getState().newDocument('gable')
  let s = store.getState()

  // ---- 1. transform state + persistence ------------------------------------
  s.setTransform({ translate: { x: 1, y: 2, z: 3 }, rotateDeg: { x: 0, y: 90, z: 0 }, scale: 1.5 })
  s.rotateObject('y', 90) // -> 180
  s = store.getState()
  r.transform = { ...s.transform }
  const file = P.toFoldFile(s.doc, s.angles, s.steps, s.history, s.transform, 'v5', s.material)
  const loaded = P.fromFoldFile(JSON.parse(JSON.stringify(file)))
  r.transformRoundtrip =
    loaded.transform.translate.x === 1 &&
    loaded.transform.translate.z === 3 &&
    Math.round(loaded.transform.rotateDeg.y) === 180 &&
    loaded.transform.scale === 1.5
  r.transformControlsExists = !!window.paperSimViewer.transformControls

  // ---- 2. select modes + edge ring -----------------------------------------
  s.setSelectMode('edge')
  // Find the edge with the largest ring (the wall top/bottom loop).
  let bestEdge = -1
  let bestRing = []
  for (const e of s.doc.edges) {
    const ring = P.edgeRing(s.doc, e.id)
    if (ring.length > bestRing.length) {
      bestRing = ring
      bestEdge = e.id
    }
  }
  r.bestRingSize = bestRing.length
  s.selectEdges(bestRing)
  r.selectedEdges = store.getState().selectedEdges.length
  r.selectModeIsEdge = store.getState().selectMode === 'edge'

  // ---- 3. axis-constrained reshape -----------------------------------------
  s = store.getState()
  const before = P.sheetBounds(s.doc)
  const beforeH = before.max.y - before.min.y
  const beforeW = before.max.x - before.min.x
  const vids = P.edgesVertexIds(s.doc, bestRing)
  const axis = P.edgesAxis(s.doc, bestRing)
  const res = P.editing.moveVertices(s.doc, vids, { x: axis.x * 1.5, y: axis.y * 1.5 })
  if ('doc' in res) {
    s.dispatch({ type: 'setDoc', label: 'reshape edge ring', prev: s.doc, next: res.doc })
  }
  s = store.getState()
  const after = P.sheetBounds(s.doc)
  r.reshapeChangedSize =
    Math.abs(after.max.y - after.min.y - beforeH) > 1e-6 ||
    Math.abs(after.max.x - after.min.x - beforeW) > 1e-6
  r.reshapeUndoable = s.canUndo()
  s.undo()
  const afterUndo = P.sheetBounds(store.getState().doc)
  r.reshapeUndone =
    Math.abs(afterUndo.max.y - afterUndo.min.y - beforeH) < 1e-6 &&
    Math.abs(afterUndo.max.x - afterUndo.min.x - beforeW) < 1e-6

  // ---- 4. mesh export (bake + OBJ + FBX bytes) -----------------------------
  s = store.getState()
  // Pose it with the template's final fold so "folded" differs from "flat".
  const poseAngles = s.steps.length ? s.steps[s.steps.length - 1].angles : s.angles
  const folded = P.bakeMesh(s.doc, s.tree, poseAngles, 'folded')
  const flat = P.bakeMesh(s.doc, s.tree, poseAngles, 'flat')
  r.bake = {
    polys: folded.polygons.length,
    faces: s.doc.faces.length,
    posOk: folded.positions.length > 0 && folded.positions.length % 3 === 0,
    triOk: folded.triangles.length > 0 && folded.triangles.length % 3 === 0,
    foldedDiffersFlat: JSON.stringify(folded.positions) !== JSON.stringify(flat.positions),
  }
  const obj = P.buildObj(folded, { name: 'paper', color: '#ccaa88' }, 'm.mtl')
  const mtl = P.buildMtl({ name: 'paper', color: '#ccaa88' })
  const fbx = P.buildFbxAscii(folded, { color: '#ccaa88' })
  r.obj = {
    hasV: /\nv /.test(obj),
    hasVt: /\nvt /.test(obj),
    hasF: /\nf /.test(obj),
    mtlHasKd: /Kd /.test(mtl),
  }
  r.fbx = {
    ver: fbx.includes('FBXVersion: 7400'),
    pvi: fbx.includes('PolygonVertexIndex'),
    uv: fbx.includes('LayerElementUV'),
  }

  // ---- 5. UV overlay transform round-trip ----------------------------------
  const tinyPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  s.setMaterial({
    ...store.getState().material,
    overlayImage: tinyPng,
    overlayTransform: { offsetX: 0.1, offsetY: 0.2, scaleX: 0.5, scaleY: 0.75, rotationDeg: 30 },
  })
  s = store.getState()
  const mfile = P.toFoldFile(s.doc, s.angles, s.steps, s.history, s.transform, 'v5', s.material)
  const mloaded = P.fromFoldFile(JSON.parse(JSON.stringify(mfile)))
  const ot = mloaded.material.overlayTransform
  r.overlayRoundtrip =
    !!ot && ot.offsetX === 0.1 && ot.scaleX === 0.5 && ot.rotationDeg === 30

  return r
})

const ok =
  out.transformRoundtrip === true &&
  out.transformControlsExists === true &&
  out.bestRingSize >= 3 &&
  out.selectedEdges === out.bestRingSize &&
  out.selectModeIsEdge === true &&
  out.reshapeChangedSize === true &&
  out.reshapeUndoable === true &&
  out.reshapeUndone === true &&
  out.bake.polys === out.bake.faces &&
  out.bake.posOk === true &&
  out.bake.triOk === true &&
  out.bake.foldedDiffersFlat === true &&
  out.obj.hasV &&
  out.obj.hasVt &&
  out.obj.hasF &&
  out.obj.mtlHasKd &&
  out.fbx.ver &&
  out.fbx.pvi &&
  out.fbx.uv &&
  out.overlayRoundtrip === true &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
