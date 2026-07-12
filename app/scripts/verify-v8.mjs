// Verifies the "image → dieline" round:
//  - analyzeImageData on a SYNTHETIC dieline (white bg, known panel grid):
//    content box, 4 wall fold lines, body band, and W/D/glue ratios recovered.
//  - analyzeDielineImage on the REAL strawberry-milk PNG (transparent bg):
//    plausible carton ratios + an overlay transform that maps the content box
//    exactly onto the sheet bounds (the artwork auto-registration).
//  - gableDimsFromAnalysis dims actually build + fold closed (bakeMesh extents
//    match the requested width/depth).
//  - End-to-end wizard path: newDocument at detected dims + registered overlay
//    renders a textured dieline.
// Usage: node scripts/verify-v8.mjs   (dev server must be running)
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const STRAWBERRY = 'L:/Projects/paper-sim/reference/dieline/pinterest_4081455908182773.png'

let strawberry = null
try {
  strawberry = 'data:image/png;base64,' + readFileSync(STRAWBERRY).toString('base64')
} catch {
  // Reference media is local-only; the real-image checks are skipped if absent.
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

const out = await page.evaluate(
  async ({ strawberry }) => {
    const P = window.paperSim
    const { store, buildGableCarton, buildPanelTree, bakeMesh } = P
    const r = {}
    const near = (a, b, tol) => Math.abs(a - b) <= tol

    // ---- 1. Synthetic dieline: known grid must be recovered ------------------
    // 900×600 white canvas; pink sheet x 60..790 y 80..520; wall fold lines at
    // x = 260/400/600/740 (W=200 D=140 W=200 D=140 glue=50); body band y 150..450.
    const c = document.createElement('canvas')
    c.width = 900
    c.height = 600
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 900, 600)
    ctx.fillStyle = 'rgb(250, 220, 225)'
    ctx.fillRect(60, 80, 731, 441)
    ctx.fillStyle = 'rgb(100, 60, 70)'
    for (const x of [260, 400, 600, 740]) ctx.fillRect(x - 1, 150, 3, 301)
    for (const y of [150, 450]) ctx.fillRect(60, y - 1, 731, 3)
    const a1 = P.analyzeImageData(ctx.getImageData(0, 0, 900, 600))
    r.synth = {
      content: a1.content,
      vLines: a1.vLines,
      hBody: a1.hBody,
      confidence: a1.confidence,
      ratios: a1.ratios && {
        width: +a1.ratios.width.toFixed(3),
        depth: +a1.ratios.depth.toFixed(3),
        glue: +a1.ratios.glue.toFixed(3),
      },
    }
    r.synthOk =
      !!a1.content &&
      near(a1.content.x, 60, 3) &&
      near(a1.content.y, 80, 3) &&
      near(a1.content.w, 731, 5) &&
      near(a1.content.h, 441, 5) &&
      a1.vLines.length === 4 &&
      near(a1.vLines[0], 260, 4) &&
      near(a1.vLines[1], 400, 4) &&
      near(a1.vLines[2], 600, 4) &&
      near(a1.vLines[3], 740, 4) &&
      !!a1.hBody &&
      near(a1.hBody.top, 150, 4) &&
      near(a1.hBody.bottom, 450, 4) &&
      !!a1.ratios &&
      near(a1.ratios.width, 200 / 300, 0.03) &&
      near(a1.ratios.depth, 140 / 300, 0.03) &&
      a1.confidence === 'good'

    // ---- 2. Real strawberry-milk dieline -------------------------------------
    if (!strawberry) {
      r.straw = { skipped: true }
      r.strawOk = true
      r.e2eOk = true
      return r
    }
    const a2 = await P.analyzeDielineImage(strawberry)
    const rat = a2.ratios
    const ov = a2.overlay
    const box = a2.content
    // Overlay must map the content box corners onto sheet fractions 0 and 1.
    const mapX = (px) => ov.scaleX * (px / a2.imageW) + ov.offsetX
    const mapY = (px) => ov.scaleY * (px / a2.imageH) + ov.offsetY
    r.straw = {
      confidence: a2.confidence,
      content: box,
      ratios: rat && {
        width: +rat.width.toFixed(3),
        depth: +rat.depth.toFixed(3),
        gable: +rat.gable.toFixed(3),
        glue: +rat.glue.toFixed(3),
      },
      overlayMaps: box
        ? [mapX(box.x), mapX(box.x + box.w), mapY(box.y), mapY(box.y + box.h)].map((v) => +v.toFixed(4))
        : null,
    }
    r.strawOk =
      a2.confidence !== 'none' &&
      !!rat &&
      rat.width > 0.3 &&
      rat.width < 0.9 &&
      rat.depth > 0.15 &&
      rat.depth < 0.6 &&
      rat.depth < rat.width &&
      !!box &&
      box.w < a2.imageW && // transparent margin got trimmed
      near(mapX(box.x), 0, 1e-6) &&
      near(mapX(box.x + box.w), 1, 1e-6) &&
      near(mapY(box.y), 0, 1e-6) &&
      near(mapY(box.y + box.h), 1, 1e-6)

    // ---- 3. Detected dims build a carton that folds closed -------------------
    const dims = P.gableDimsFromAnalysis(a2, 13)
    const doc = buildGableCarton(dims)
    const angles = doc.targetAngles ?? {}
    const finite = Object.values(angles).every((v) => Number.isFinite(v))
    const mesh = bakeMesh(doc, buildPanelTree(doc), angles, 'folded')
    let minx = 1e9,
      maxx = -1e9,
      miny = 1e9,
      maxy = -1e9
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minx = Math.min(minx, mesh.positions[i])
      maxx = Math.max(maxx, mesh.positions[i])
      miny = Math.min(miny, mesh.positions[i + 1])
      maxy = Math.max(maxy, mesh.positions[i + 1])
    }
    r.build = {
      dims: { w: +dims.width.toFixed(2), d: +dims.depth.toFixed(2), h: dims.height },
      foldedW: +(maxx - minx).toFixed(2),
      foldedD: +(maxy - miny).toFixed(2),
      finiteTargets: finite,
    }
    // Folded lies on its front: x extent = width, y extent = depth.
    r.buildOk =
      finite &&
      Math.abs(maxx - minx - dims.width) < dims.width * 0.12 &&
      Math.abs(maxy - miny - dims.depth) < dims.depth * 0.15

    // ---- 4. End-to-end wizard path -------------------------------------------
    store.getState().newDocument('gable', dims)
    store.getState().setProjectName('strawberry import')
    let s = store.getState()
    s.setMaterial({
      baseColor: '#f4efe6',
      baseKind: 'color',
      overlayImage: strawberry,
      overlayTransform: a2.overlay,
    })
    s = store.getState()
    const png = await P.dielineTexturePNG(s.doc, s.material)
    r.e2e = { pngBytes: png.size, name: s.projectName, steps: s.steps.length }
    r.e2eOk = png.size > 5000 && s.projectName === 'strawberry import' && s.steps.length > 0
    return r
  },
  { strawberry },
)

const ok =
  out.synthOk === true &&
  out.strawOk === true &&
  (out.buildOk === true || out.straw?.skipped === true) &&
  out.e2eOk === true &&
  pageErrors.length === 0

console.log(JSON.stringify({ out, pageErrors, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
