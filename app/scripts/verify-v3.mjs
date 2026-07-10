// v1 feature round verification: gable carton geometry, group folds,
// dieline editing ops + undo, generic FOLD import, object rotation persist,
// exports, and the duplicate-step-id crash fix.
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
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)

const results = await page.evaluate(async () => {
  const ps = window.paperSim
  const store = ps.store
  const out = {}
  const s = () => store.getState()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ---- 1. gable carton: build + closure at target angles -------------------
  s().newDocument('gable')
  await sleep(50)
  const doc = s().doc
  const tree = s().tree
  out.gableFaces = doc.faces.length
  out.gableHinges = tree.hingeEdgeIds.length
  out.gableTargets = Object.keys(doc.targetAngles ?? {}).length

  // Pose at 100% of targets, then measure whether points that must meet in a
  // sealed gable actually coincide (frame-independent closure check).
  const rad = {}
  for (const [k, v] of Object.entries(doc.targetAngles)) rad[k] = ps.degToRad(v)
  const matrices = ps.computeFaceMatrices(doc, tree, rad)
  const facesOfVertex = (vid) => doc.faces.filter((f) => f.vertexIds.includes(vid))
  const vertexAt = (x, y) =>
    doc.vertices.find((v) => Math.abs(v.pos.x - x) < 1e-6 && Math.abs(v.pos.y - y) < 1e-6)
  const posed = (vid) => {
    // Use any face containing the vertex that has a matrix (they agree only
    // if the pattern is kinematically consistent -- also checked below).
    const face = facesOfVertex(vid).find((f) => matrices.has(f.id))
    const m = matrices.get(face.id)
    const v = doc.vertices.find((v) => v.id === vid).pos
    const e = m.elements
    return [
      e[0] * v.x + e[4] * v.y + e[12],
      e[1] * v.x + e[5] * v.y + e[13],
      e[2] * v.x + e[6] * v.y + e[14],
    ]
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  // Consistency: every face containing a vertex must place it at the same
  // point (loops through the gusset/rib cycle must close).
  let worstLoop = 0
  for (const v of doc.vertices) {
    const pts = facesOfVertex(v.id)
      .filter((f) => matrices.has(f.id))
      .map((f) => {
        const e = matrices.get(f.id).elements
        return [
          e[0] * v.pos.x + e[4] * v.pos.y + e[12],
          e[1] * v.pos.x + e[5] * v.pos.y + e[13],
          e[2] * v.pos.x + e[6] * v.pos.y + e[14],
        ]
      })
    for (let i = 1; i < pts.length; i++) worstLoop = Math.max(worstLoop, dist(pts[0], pts[i]))
  }
  out.gableWorstLoopError = Number(worstLoop.toFixed(5))

  // Meeting pairs (distinct flat vertices that touch when sealed):
  const S = 4
  const H = 10
  const G = 3
  const R = 0.9
  const pairs = [
    [vertexAt(0, H + G), vertexAt(4 * S, H + G)], // roof corners meet over left wall
    [vertexAt(S + S / 2, H + G), vertexAt(3 * S + S / 2, H + G)], // the two gusset apexes meet at the peak
    [vertexAt(0, H + G + R), vertexAt(4 * S, H + G + R)], // rib tops meet
    [vertexAt(0, 0), vertexAt(4 * S, 0)], // glue seam closes the body
  ]
  out.gableMeetErrors = pairs.map(([a, b]) =>
    a && b ? Number(dist(posed(a.id), posed(b.id)).toFixed(4)) : 'missing-vertex',
  )

  // ---- 2. group fold + undo -------------------------------------------------
  const gusset = doc.faces.find((f) => f.name === 'right side gusset left')
  const gusset2 = doc.faces.find((f) => f.name === 'right side gusset right')
  s().selectFace(gusset.id)
  s().selectFace(gusset2.id, true)
  out.selectionSize = s().selection.length
  const h1 = tree.nodes.get(gusset.id).hingeEdgeId
  const h2 = tree.nodes.get(gusset2.id).hingeEdgeId
  s().dispatch({
    type: 'setAngles',
    changes: [
      { edgeId: h1, prev: 0, next: 40 },
      { edgeId: h2, prev: 0, next: 40 },
    ],
  })
  out.groupFoldApplied = [s().angles[h1], s().angles[h2]]
  s().undo()
  out.groupFoldUndone = [s().angles[h1] ?? 0, s().angles[h2] ?? 0]

  // ---- 3. dieline editing ops + undo ---------------------------------------
  s().newDocument('tuck')
  await sleep(30)
  const d0 = s().doc
  const faces0 = d0.faces.length
  const front = d0.faces.find((f) => f.name === 'front')
  const c1 = d0.vertices.find((v) => v.pos.x === 0 && v.pos.y === 0)
  const c2 = d0.vertices.find((v) => v.pos.x === 6 && v.pos.y === 12)
  const res = ps.editing.addSegment(
    d0,
    { kind: 'vertex', vertexId: c1.id },
    { kind: 'vertex', vertexId: c2.id },
    'crease',
  )
  if (res.error) {
    out.editError = res.error
  } else {
    s().dispatch({ type: 'setDoc', label: 'draw crease', prev: d0, next: res.doc })
    out.facesAfterDraw = s().doc.faces.length // faces0 + 1
    out.treeRebuilt = s().tree.nodes.size === s().doc.faces.length
    // New diagonal hinge should fold: find the new edge (between c1, c2).
    const diag = s().doc.edges.find(
      (e) =>
        (e.v1 === c1.id && e.v2 === c2.id) || (e.v1 === c2.id && e.v2 === c1.id),
    )
    out.diagIsCrease = diag?.kind === 'crease'
    // Delete it again via removeEdge (merge).
    const res2 = ps.editing.removeEdge(s().doc, diag.id)
    if (res2.error) out.mergeError = res2.error
    else {
      s().dispatch({ type: 'setDoc', label: 'delete line', prev: s().doc, next: res2.doc })
      out.facesAfterMerge = s().doc.faces.length // faces0
    }
    s().undo() // undo merge
    out.facesAfterUndoMerge = s().doc.faces.length
    s().undo() // undo draw
    out.facesAfterUndoDraw = s().doc.faces.length
    s().redo()
    out.facesAfterRedo = s().doc.faces.length
    void front
  }

  // ---- 4. generic FOLD import ------------------------------------------------
  const foreign = {
    file_spec: 1.1,
    file_creator: 'SomeOtherTool',
    vertices_coords: [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [4, 0],
      [4, 2],
    ],
    edges_vertices: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [1, 4],
      [4, 5],
      [5, 2],
    ],
    edges_assignment: ['B', 'V', 'B', 'B', 'B', 'B', 'B'],
    edges_foldAngle: [0, 120, 0, 0, 0, 0, 0],
    faces_vertices: [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ],
  }
  try {
    s().loadFile(foreign, 'foreign.fold')
    out.foreignFaces = s().doc.faces.length
    out.foreignHinges = s().tree.hingeEdgeIds.length
    const hingeEdge = s().tree.hingeEdgeIds[0]
    out.foreignTarget = s().doc.targetAngles?.[hingeEdge]
  } catch (e) {
    out.foreignError = String(e)
  }

  // ---- 5. object rotation persist ---------------------------------------------
  s().newDocument('gable')
  s().rotateObject('x', 90)
  s().rotateObject('y', -90)
  const file = ps.toFoldFile(s().doc, s().angles, s().steps, s().history, s().objectRotation)
  out.savedRotation = file['paperSim:objectRotation']
  s().newDocument('tuck')
  s().loadFile(JSON.parse(JSON.stringify(file)), 'rot.fold')
  out.loadedRotation = s().objectRotation

  // ---- 6. exports ---------------------------------------------------------------
  const svg = ps.dielineSVG(s().doc)
  out.svgOk = svg.startsWith('<svg') && svg.includes('<line')
  const shots = window.paperSimViewer.capture([{}, s().doc.targetAngles ?? {}])
  out.captureOk = shots.length === 2 && shots.every((u) => u.startsWith('data:image/png'))

  // ---- 7. duplicate-step-id regression ------------------------------------------
  s().newDocument('tuck')
  await sleep(30)
  const anyHinge = s().tree.hingeEdgeIds[0]
  s().dispatch({ type: 'setAngle', edgeId: anyHinge, prev: 0, next: 90 })
  s().addKeyframe()
  s().addKeyframe()
  s().editStepInPlace(1)
  s().addKeyframe()
  const addIdx = s().history.log.findIndex((op) => op.type === 'addStep')
  s().deleteOpAt(addIdx)
  for (let i = 0; i < 20; i++) s().undo()
  for (let i = 0; i < 20; i++) s().redo()
  const ids = s().steps.map((st) => st.id)
  out.stepIdsUnique = new Set(ids).size === ids.length

  return out
})

await new Promise((r) => setTimeout(r, 400))
console.log(JSON.stringify({ results, pageErrors }, null, 2))
await browser.close()
process.exit(pageErrors.length > 0 ? 1 : 0)
