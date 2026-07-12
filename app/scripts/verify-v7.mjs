// Verifies the "trustworthy reshape + print-ready PDF" round:
//  - Edge-ring reshape moves the WHOLE region beyond the ring (ringRegionVertexIds):
//    panels past the ring keep their exact shape (all their edge lengths), and the
//    reshaped rect gable still folds CLOSED at the new height (no exploding top).
//  - The store-level reshape is transient-then-committed and undoable (unchanged).
//  - True-scale PDF: single page when the sheet fits A4, tiled pages when not,
//    scale/tile annotations present, and the artwork JPEG embeds exactly once.
// Usage: node scripts/verify-v7.mjs   (dev server must be running)
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

/** Horizontal (xz) extent + vertical extent of a baked, folded mesh. */
function extentsFn() {
  return (mesh) => {
    let minx = 1e9,
      maxx = -1e9,
      miny = 1e9,
      maxy = -1e9,
      minz = 1e9,
      maxz = -1e9
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3) {
      minx = Math.min(minx, p[i])
      maxx = Math.max(maxx, p[i])
      miny = Math.min(miny, p[i + 1])
      maxy = Math.max(maxy, p[i + 1])
      minz = Math.min(minz, p[i + 2])
      maxz = Math.max(maxz, p[i + 2])
    }
    return { w: maxx - minx, h: maxy - miny, d: maxz - minz }
  }
}

const out = await page.evaluate(
  async ({ extentsSrc }) => {
    const P = window.paperSim
    const { store, buildGableCarton, buildPanelTree, bakeMesh } = P
    const extents = new Function('return (' + extentsSrc + ')()')()
    const r = {}

    const edgeLengths = (doc) => {
      const pos = (id) => doc.vertices.find((v) => v.id === id).pos
      const m = {}
      for (const e of doc.edges) {
        const a = pos(e.v1)
        const b = pos(e.v2)
        m[e.id] = Math.hypot(b.x - a.x, b.y - a.y)
      }
      return m
    }

    // ---- 1. Ring region: reshape preserves the cap's shape -------------------
    const doc = buildGableCarton({ width: 5, depth: 3.2, height: 13 })
    // Seed on the SHOULDER ring (horizontal creases at y = height): the ring a
    // user double-clicks to shorten the carton — the exploding-carton repro.
    const vpos = (d, id) => d.vertices.find((v) => v.id === id).pos
    let seedId = -1
    for (const e of doc.edges) {
      if (e.kind !== 'crease') continue
      if (Math.abs(vpos(doc, e.v1).y - 13) < 1e-6 && Math.abs(vpos(doc, e.v2).y - 13) < 1e-6) {
        seedId = e.id
        break
      }
    }
    r.shoulderSeedFound = seedId >= 0
    const bestRing = P.edgeRing(doc, seedId)
    r.shoulderRingSize = bestRing.length
    const ringVids = new Set(P.edgesVertexIds(doc, bestRing))
    const region = P.ringRegionVertexIds(doc, bestRing)
    const regionSet = new Set(region)
    // The region must reach past the ring itself (gable/flap vertices).
    r.regionBiggerThanRing = region.length > ringVids.size
    r.regionContainsRing = [...ringVids].every((id) => regionSet.has(id))

    // Shorten by 3 (13 -> 10 body): 1L -> 250ml style edit.
    const axis = P.edgesAxis(doc, bestRing)
    const res = P.editing.moveVertices(doc, region, { x: axis.x * -3, y: axis.y * -3 })
    r.reshapeApplied = 'doc' in res
    const short = res.doc

    // Every edge fully inside the moved region (the cap) and every edge fully
    // outside it keeps its exact length — only band-crossing edges stretch.
    const before = edgeLengths(doc)
    const after = edgeLengths(short)
    let capKept = true
    let outsideKept = true
    let crossingChanged = 0
    for (const e of doc.edges) {
      const inA = regionSet.has(e.v1)
      const inB = regionSet.has(e.v2)
      const same = Math.abs(before[e.id] - after[e.id]) < 1e-9
      if (inA && inB && !same) capKept = false
      if (!inA && !inB && !same) outsideKept = false
      if (inA !== inB && !same) crossingChanged++
    }
    r.capShapePreserved = capKept
    r.outsidePreserved = outsideKept
    r.wallsStretched = crossingChanged > 0

    // The reshaped carton still folds closed: same W/D cross-section, ~3 less
    // length, and nothing sticking out (the old bug exploded the gable).
    const foldedShort = extents(bakeMesh(short, buildPanelTree(short), short.targetAngles ?? {}, 'folded'))
    const foldedOrig = extents(bakeMesh(doc, buildPanelTree(doc), doc.targetAngles ?? {}, 'folded'))
    r.folded = {
      orig: { w: +foldedOrig.w.toFixed(2), h: +foldedOrig.h.toFixed(2), d: +foldedOrig.d.toFixed(2) },
      short: { w: +foldedShort.w.toFixed(2), h: +foldedShort.h.toFixed(2), d: +foldedShort.d.toFixed(2) },
    }
    r.foldedStillCloses =
      Math.abs(foldedShort.w - foldedOrig.w) < 0.15 &&
      Math.abs(foldedShort.h - foldedOrig.h) < 0.15 &&
      Math.abs(foldedOrig.d - foldedShort.d - 3) < 0.3

    // ---- 2. Store-level reshape still transient + undoable -------------------
    store.getState().newDocument('gable', { width: 5, depth: 3.2, height: 13 })
    let s = store.getState()
    let seed2 = -1
    for (const e of s.doc.edges) {
      if (e.kind !== 'crease') continue
      if (Math.abs(vpos(s.doc, e.v1).y - 13) < 1e-6 && Math.abs(vpos(s.doc, e.v2).y - 13) < 1e-6) {
        seed2 = e.id
        break
      }
    }
    const ring2 = P.edgeRing(s.doc, seed2)
    const vids2 = P.ringRegionVertexIds(s.doc, ring2)
    const axis2 = P.edgesAxis(s.doc, ring2)
    const beforeB = P.sheetBounds(s.doc)
    const res2 = P.editing.moveVertices(s.doc, vids2, { x: axis2.x * -2, y: axis2.y * -2 })
    s.dispatch({ type: 'setDoc', label: 'reshape edge ring', prev: s.doc, next: res2.doc })
    s = store.getState()
    const afterB = P.sheetBounds(s.doc)
    r.storeReshapeChanged = Math.abs(afterB.max.y - afterB.min.y - (beforeB.max.y - beforeB.min.y)) > 1e-6
    r.storeReshapeUndoable = s.canUndo()
    s.undo()
    const undoneB = P.sheetBounds(store.getState().doc)
    r.storeReshapeUndone = Math.abs(undoneB.max.y - undoneB.min.y - (beforeB.max.y - beforeB.min.y)) < 1e-6

    // ---- 3. True-scale PDF ----------------------------------------------------
    // Rect gable sheet is ~17.5 x ~25 cm: fits one A4 portrait page at 1:1.
    store.getState().newDocument('gable', { width: 5, depth: 3.2, height: 13 })
    s = store.getState()
    const one = await P.dielinePDFTrueScale(s.doc, 'fit-test')
    const oneText = await one.text()
    r.pdfOne = {
      magic: oneText.slice(0, 5),
      pages: +(oneText.match(/\/Count (\d+)/)?.[1] ?? 0),
      declaresScale: oneText.includes('TRUE SCALE'),
      calibrationBar: oneText.includes('5 cm'),
    }

    // A 30cm-tall carton's sheet (~42 cm with flaps) cannot fit one page: tiles.
    store.getState().newDocument('gable', { width: 5, depth: 3.2, height: 30 })
    s = store.getState()
    const tiled = await P.dielinePDFTrueScale(s.doc, 'tile-test')
    const tiledText = await tiled.text()
    r.pdfTiled = {
      pages: +(tiledText.match(/\/Count (\d+)/)?.[1] ?? 0),
      tileLabels: tiledText.includes('tile 1,1'),
    }

    // Artwork variant embeds the JPEG exactly once no matter how many tiles.
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    s.setMaterial({ ...s.material, overlayImage: tinyPng })
    s = store.getState()
    const art = await P.dielinePDFTrueScale(s.doc, 'tile-art-test', s.material)
    const artText = await art.text()
    r.pdfArt = {
      pages: +(artText.match(/\/Count (\d+)/)?.[1] ?? 0),
      jpegEmbeds: (artText.match(/\/Subtype \/Image/g) ?? []).length,
      drawsPerPage: (artText.match(/\/Im0 Do/g) ?? []).length,
    }

    return r
  },
  { extentsSrc: extentsFn.toString() },
)

const ok =
  out.shoulderSeedFound === true &&
  out.shoulderRingSize >= 4 &&
  out.regionBiggerThanRing === true &&
  out.regionContainsRing === true &&
  out.reshapeApplied === true &&
  out.capShapePreserved === true &&
  out.outsidePreserved === true &&
  out.wallsStretched === true &&
  out.foldedStillCloses === true &&
  out.storeReshapeChanged === true &&
  out.storeReshapeUndoable === true &&
  out.storeReshapeUndone === true &&
  out.pdfOne.magic === '%PDF-' &&
  out.pdfOne.pages === 1 &&
  out.pdfOne.declaresScale === true &&
  out.pdfOne.calibrationBar === true &&
  out.pdfTiled.pages >= 2 &&
  out.pdfTiled.tileLabels === true &&
  out.pdfArt.pages >= 2 &&
  out.pdfArt.jpegEmbeds === 1 &&
  out.pdfArt.drawsPerPage === out.pdfArt.pages &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
