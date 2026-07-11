// Verifies the "image → dieline / can / textured export" round:
//  - Can (faceted cylinder): targets = 360/N per crease; folds into a compact tube.
//  - Rectangular gable: parametric W/D/H folds into a carton of those proportions
//    (and the square gable still folds square — regression).
//  - Textured dieline export: PNG bytes, SVG embeds artwork, PDF is a real PDF.
//  - Trace backdrop: store round-trips and clears on newDocument.
//  - Strawberry milk PNG maps end-to-end as an overlay onto the dieline.
// Usage: node scripts/verify-v6.mjs   (dev server must be running)
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const STRAWBERRY = 'L:/Projects/paper-sim/reference/dieline/pinterest_4081455908182773.png'

// Load the real strawberry-milk dieline image as a data URL, if present.
let strawberryDataUrl = null
try {
  strawberryDataUrl = 'data:image/png;base64,' + readFileSync(STRAWBERRY).toString('base64')
} catch {
  // Reference media is local-only; the overlay check is skipped if absent.
}

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
  async ({ strawberry, extentsSrc }) => {
    const P = window.paperSim
    const { store, buildCan, buildGableCarton, buildPanelTree, bakeMesh } = P
    const extents = new Function('return (' + extentsSrc + ')()')()
    const r = {}

    // ---- 1. Can: faceted cylinder ------------------------------------------
    const N = 24
    const can = buildCan({ facets: N, height: 10, radius: 3, seam: true })
    const canTree = buildPanelTree(can)
    const targets = can.targetAngles ?? {}
    const tvals = Object.values(targets)
    r.can = {
      panels: can.faces.length, // N panels + seam flap
      targetCount: tvals.length,
      turnOk: tvals.every((t) => Math.abs(t - 360 / N) < 1e-6),
    }
    const canFlat = bakeMesh(can, canTree, targets, 'flat')
    const canFolded = bakeMesh(can, canTree, targets, 'folded')
    const ef = extents(canFlat)
    const ofold = extents(canFolded)
    // bakeMesh rests the root panel on the ground: the tube wraps in the x-y
    // cross-section (~2r=6 diameter) with its length along z (=height 10).
    // Flat strip is long along x (~perimeter 2πr≈18.8).
    r.can.flatWide = ef.w > 15
    r.can.foldedCompact = ofold.w < 7.5 && ofold.h < 7.5
    r.can.foldedHeight = Math.abs(ofold.d - 10) < 0.8

    // ---- 2. Rectangular gable ----------------------------------------------
    const rect = buildGableCarton({ width: 5, depth: 3.2, height: 13 })
    const rectTree = buildPanelTree(rect)
    const rectAngles = rect.targetAngles ?? {}
    r.rectFinite =
      Object.keys(rectAngles).length > 10 &&
      Object.values(rectAngles).every((a) => Number.isFinite(a))
    const rf = extents(bakeMesh(rect, rectTree, rectAngles, 'folded'))
    // Folded carton lies on its front face: width W along x, depth D along y,
    // and the body+gable (~15.7 tall) runs along the ground z.
    r.rect = {
      w: +rf.w.toFixed(2),
      d: +rf.d.toFixed(2),
      h: +rf.h.toFixed(2),
      ok: rf.w > 4.5 && rf.w < 5.6 && rf.h > 2.8 && rf.h < 3.7 && rf.d > 14.5 && rf.d < 17,
    }
    // Regression: the square gable still folds square (W == D).
    const sq = buildGableCarton()
    const sqf = extents(bakeMesh(sq, buildPanelTree(sq), sq.targetAngles ?? {}, 'folded'))
    r.squareStillSquare = Math.abs(sqf.w - sqf.h) < 0.5 && sqf.w > 3.5 && sqf.w < 4.5

    // ---- 3. Textured dieline export ----------------------------------------
    store.getState().newDocument('gable')
    let s = store.getState()
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    s.setMaterial({ ...s.material, overlayImage: tinyPng })
    s = store.getState()
    const png = await P.dielineTexturePNG(s.doc, s.material)
    const artUrl = await P.dielineArtworkDataUrl(s.doc, s.material)
    const svg = P.dielineSVG(s.doc, artUrl)
    const pdf = await P.dielinePDF(s.doc, 'tex', s.material)
    r.tex = {
      pngBytes: png.size,
      svgHasImage: svg.includes('<image') && svg.includes('href="data:image'),
      pdfMagic: await pdf.slice(0, 5).text(),
      pdfBytes: pdf.size,
    }

    // ---- 3b. Edge-ring move handle shows in edge mode (edit mode) ----------
    store.getState().newDocument('gable')
    let es = store.getState()
    es.setSelectMode('edge')
    es.setTransformTool('move')
    let bestRing = [],
      bestId = -1
    for (const e of es.doc.edges) {
      const ring = P.edgeRing(es.doc, e.id)
      if (ring.length > bestRing.length) {
        bestRing = ring
        bestId = e.id
      }
    }
    es.selectEdges(bestRing)
    void bestId
    await new Promise((res) => setTimeout(res, 250)) // let a frame place the handle
    r.edgeHandle = {
      shown: window.paperSimViewer.edgeHandleVisible(),
      // Whole-object gizmo is suppressed in edge mode.
      objGizmoHidden: window.paperSimViewer.transformControls.visible === false,
    }
    // Back to object mode: whole-object gizmo returns, edge handle hides.
    store.getState().setSelectMode('object')
    await new Promise((res) => setTimeout(res, 250))
    r.edgeHandle.hidesInObjectMode = window.paperSimViewer.edgeHandleVisible() === false

    // ---- 4. Trace backdrop --------------------------------------------------
    s.setBackdrop({ image: tinyPng, x: -1, y: 12, w: 20, h: 24, opacity: 0.5 })
    r.backdropSet = store.getState().backdrop?.w === 20
    store.getState().newDocument('tuck')
    r.backdropClearedOnNew = store.getState().backdrop === null

    // ---- 5. Strawberry milk overlay (real image) ---------------------------
    if (strawberry) {
      store.getState().newDocument('gable', { width: 5, depth: 3.2, height: 13 })
      let ss = store.getState()
      ss.setMaterial({ ...ss.material, overlayImage: strawberry })
      ss = store.getState()
      const spng = await P.dielineTexturePNG(ss.doc, ss.material)
      r.strawberry = { mapped: spng.size > 5000, bytes: spng.size }
    } else {
      r.strawberry = { skipped: true }
    }

    return r
  },
  { strawberry: strawberryDataUrl, extentsSrc: extentsFn.toString() },
)

const ok =
  out.can.panels === 25 &&
  out.can.targetCount === 24 &&
  out.can.turnOk === true &&
  out.can.flatWide === true &&
  out.can.foldedCompact === true &&
  out.can.foldedHeight === true &&
  out.rectFinite === true &&
  out.rect.ok === true &&
  out.squareStillSquare === true &&
  out.tex.pngBytes > 1000 &&
  out.tex.svgHasImage === true &&
  out.tex.pdfMagic === '%PDF-' &&
  out.edgeHandle.shown === true &&
  out.edgeHandle.objGizmoHidden === true &&
  out.edgeHandle.hidesInObjectMode === true &&
  out.backdropSet === true &&
  out.backdropClearedOnNew === true &&
  (out.strawberry.skipped === true || out.strawberry.mapped === true) &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
