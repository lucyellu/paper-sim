// Verifies the "sleeves + US Letter" round:
//  - Juice-box sleeve template: 4 panels + seam, all vertical creases target
//    90°, folds into a rectangular tube of the requested W×D×H; ships with a
//    one-step fold; store template 'sleeve' works end to end.
//  - Can-sleeve preset dims: 24-facet band whose inscribed circle clears a
//    standard 12 oz can (Ø 6.6 cm) and folds compact.
//  - All PDF exports are US Letter (612×792) — the true-scale PDF states the
//    scale and still fits the default carton on one page.
// Usage: node scripts/verify-v9.mjs   (dev server must be running)
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

const out = await page.evaluate(async () => {
  const P = window.paperSim
  const { store, buildSleeve, buildCan, buildPanelTree, bakeMesh } = P
  const r = {}
  const near = (a, b, tol) => Math.abs(a - b) <= tol

  const extents = (mesh) => {
    let mn = [1e9, 1e9, 1e9]
    let mx = [-1e9, -1e9, -1e9]
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], mesh.positions[i + k])
        mx[k] = Math.max(mx[k], mesh.positions[i + k])
      }
    }
    return [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
  }

  // ---- 1. Juice-box sleeve folds into the right tube ------------------------
  const dims = { width: 5.5, depth: 4.3, height: 7, seam: true }
  const sleeve = buildSleeve(dims)
  const targets = sleeve.targetAngles ?? {}
  r.sleeve = {
    faces: sleeve.faces.length,
    creases: Object.keys(targets).length,
    all90: Object.values(targets).every((t) => t === 90),
  }
  const folded = extents(bakeMesh(sleeve, buildPanelTree(sleeve), targets, 'folded')).sort((a, b) => a - b)
  const want = [4.3, 5.5, 7].sort((a, b) => a - b)
  r.sleeveFolded = folded.map((v) => +v.toFixed(2))
  r.sleeveOk =
    sleeve.faces.length === 5 &&
    Object.keys(targets).length === 4 &&
    r.sleeve.all90 &&
    near(folded[0], want[0], 0.4) &&
    near(folded[1], want[1], 0.4) &&
    near(folded[2], want[2], 0.4)

  // ---- 2. Store template end-to-end ----------------------------------------
  store.getState().newDocument('sleeve', dims)
  const s = store.getState()
  r.store = { steps: s.steps.length, name: s.projectName, stepName: s.steps[0]?.name }
  r.storeOk = s.steps.length === 1 && s.projectName === 'sleeve' && /wrap/i.test(s.steps[0].name)

  // ---- 3. Can-sleeve preset clears a 12 oz can ------------------------------
  const canDims = { facets: 24, height: 9, radius: 3.45, seam: true }
  const canSleeve = buildCan(canDims)
  // Inscribed-circle radius (apothem) of the folded 24-gon must exceed the
  // can's 3.3 cm radius.
  const apothem = canDims.radius * Math.cos(Math.PI / canDims.facets)
  const canFolded = extents(
    bakeMesh(canSleeve, buildPanelTree(canSleeve), canSleeve.targetAngles ?? {}, 'folded'),
  )
  r.canSleeve = { apothem: +apothem.toFixed(3), folded: canFolded.map((v) => +v.toFixed(2)) }
  r.canOk = apothem > 3.3 && Math.max(...canFolded) < 9.6 && Math.min(...canFolded) > 6

  // ---- 4. US Letter pages ----------------------------------------------------
  store.getState().newDocument('gable', { width: 5, depth: 3.2, height: 13 })
  const st = store.getState()
  const one = await P.dielinePDFTrueScale(st.doc, 'letter-test')
  const oneText = await one.text()
  const fit = await P.dielinePDF(st.doc, 'letter-test')
  const fitText = await fit.text()
  r.letter = {
    trueScalePages: +(oneText.match(/\/Count (\d+)/)?.[1] ?? 0),
    trueScaleLetter: oneText.includes('/MediaBox [0 0 612 792]'),
    saysLetter: oneText.includes('US Letter'),
    fitLetter: fitText.includes('612') && fitText.includes('792'),
  }
  r.letterOk =
    r.letter.trueScalePages === 1 &&
    r.letter.trueScaleLetter &&
    r.letter.saysLetter &&
    r.letter.fitLetter

  return r
})

const ok =
  out.sleeveOk === true &&
  out.storeOk === true &&
  out.canOk === true &&
  out.letterOk === true &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
