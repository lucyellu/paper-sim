// Verifies the "fit-the-grid" dieline importer round:
//  1. Parametric tuck-end boxes (straight + reverse, both panel orders, both
//     glue sides, both lid panels) fold at their target angles to exactly
//     W × D × H with no interpenetrating panels and no same-kind panels stacked
//     on each other (dust-on-dust, lid-on-lid…).
//  2. The wizard, driven through the real File menu on #126 (cherry cloud,
//     reverse tuck, narrow panel first, glue right): guides are dragged to
//     scripted positions, the box builds with the expected params, the overlay
//     registers the picture (front-panel center color ≈ the picture's), the
//     true-scale PDF is ONE Letter page, and Re-fit reopens the fit.
//  3. Gable regression: #110 (…773, strawberry milk) through the same wizard
//     as a gable carton.
//  4. Print checks: the print canvas bleeds past the cut outline and blanks the
//     rest; the PDF footer states size, dpi and cut/score.
//  5. Trace-anything: "Use backdrop as artwork" registers the backdrop image.
// Screenshots of each folded result land in scripts/shots/.
// Usage: node scripts/verify-v13.mjs   (dev server must be running; needs the
// local-only reference/dieline/ pictures)
import { chromium } from 'playwright'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const REF = (name) => fileURLToPath(new globalThis.URL(`../../reference/dieline/${name}`, import.meta.url))
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
const CHERRY = REF('pinterest_4081455908182793.png')
const MILK = REF('pinterest_4081455908182773.png')
const KITTY = REF('pinterest_4081455908182783.jpg')
const BUTTER = REF('pinterest_4081455908182770.jpg')
const LABUBU = REF('pinterest_4081455908182791.jpg')
const PRINT = fileURLToPath(new globalThis.URL('../../print/', import.meta.url))
for (const f of [CHERRY, MILK, KITTY, BUTTER, LABUBU]) {
  if (!existsSync(f)) {
    console.error(`test image missing: ${f}`)
    process.exit(1)
  }
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

// ---- 1. Tuck box geometry ------------------------------------------------------
const geometry = await page.evaluate(() => {
  const P = window.paperSim
  const EPS = 1e-4
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const norm = (a) => {
    const l = Math.hypot(...a)
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  const newell = (pts) => {
    const n = [0, 0, 0]
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      n[0] += (p[1] - q[1]) * (p[2] + q[2])
      n[1] += (p[2] - q[2]) * (p[0] + q[0])
      n[2] += (p[0] - q[0]) * (p[1] + q[1])
    }
    return norm(n)
  }
  const kind = (name) =>
    /dust/.test(name) ? 'dust' : /lid/.test(name) ? 'lid' : /tuck/.test(name) ? 'tuck' : /glue/.test(name) ? 'glue' : 'wall'
  // Transversal interpenetration: A ∩ plane(B) is a segment; clip it to B's
  // interior (Cyrus–Beck, with a margin) — any length left means the panels
  // pass through each other. Edge-aligned crossings are caught too.
  const crosses = (A, B) => {
    const n = newell(B)
    const d = dot(n, B[0])
    const seg = []
    for (let i = 0; i < A.length; i++) {
      const p = A[i]
      const q = A[(i + 1) % A.length]
      const dp = dot(n, p) - d
      const dq = dot(n, q) - d
      if (dp * dq >= 0 || Math.abs(dp) < EPS || Math.abs(dq) < EPS) continue
      const t = dp / (dp - dq)
      seg.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t])
    }
    if (seg.length < 2) return false
    const [P, Q] = seg
    let t0 = 0
    let t1 = 1
    for (let i = 0; i < B.length; i++) {
      const b = B[i]
      const e = sub(B[(i + 1) % B.length], b)
      const m = 1e-3 * Math.hypot(...e)
      const fP = dot(cross(e, sub(P, b)), n) - m
      const fQ = dot(cross(e, sub(Q, b)), n) - m
      if (fP < 0 && fQ < 0) return false
      if (fP < 0) t0 = Math.max(t0, fP / (fP - fQ))
      else if (fQ < 0) t1 = Math.min(t1, fP / (fP - fQ))
    }
    return (t1 - t0) * Math.hypot(...sub(Q, P)) > 1e-3
  }
  // Coplanar overlap area (Sutherland–Hodgman clip in the shared plane).
  const coplanarArea = (A, B) => {
    const nA = newell(A)
    const nB = newell(B)
    if (Math.abs(dot(nA, nB)) < 1 - 1e-6 || Math.abs(dot(nB, A[0]) - dot(nB, B[0])) > EPS) return 0
    const u = norm(sub(B[1], B[0]))
    const v = cross(nB, u)
    const to2 = (p) => [dot(sub(p, B[0]), u), dot(sub(p, B[0]), v)]
    const area = (P) => P.reduce((s, p, i) => s + (p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1]), 0) / 2
    let subj = A.map(to2)
    let clip = B.map(to2)
    if (area(clip) < 0) clip = clip.reverse()
    for (let i = 0; i < clip.length && subj.length; i++) {
      const a = clip[i]
      const b = clip[(i + 1) % clip.length]
      const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
      const out = []
      for (let j = 0; j < subj.length; j++) {
        const p = subj[j]
        const q = subj[(j + 1) % subj.length]
        const sp = side(p)
        const sq = side(q)
        if (sp >= 0) out.push(p)
        if (sp * sq < 0) {
          const t = sp / (sp - sq)
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
        }
      }
      subj = out
    }
    return subj.length < 3 ? 0 : Math.abs(area(subj))
  }

  // Self-test so the checks can't pass vacuously: a square pierced by a
  // perpendicular one, and two squares stacked in the same plane.
  const sq = (f) => [[0, 0], [2, 0], [2, 2], [0, 2]].map(([a, b]) => f(a, b))
  const detector = {
    pierced: crosses(sq((a, b) => [a - 1, 1, b - 1]), sq((a, b) => [a - 1, b, 0])),
    stacked: coplanarArea(sq((a, b) => [a, b, 0]), sq((a, b) => [a + 1, b + 1, 0])) > 0.9,
    apart: !crosses(sq((a, b) => [a, b, 0]), sq((a, b) => [a + 5, b, 1])),
  }

  let hiddenPairs = 0
  const results = [{ key: 'detector self-test', ...detector, ok: detector.pierced && detector.stacked && detector.apart }]
  const W = 6
  const D = 3
  const H = 9
  for (const style of ['straight', 'reverse'])
    for (const order of ['front-first', 'side-first'])
      for (const glueSide of ['right', 'left'])
        for (const lidOn of ['first', 'second']) {
          const params = { width: W, depth: D, height: H, style, order, glueSide, lidOn }
          const doc = P.buildTuckBox(params)
          const tree = P.buildPanelTree(doc)
          const angles = {}
          for (const [e, a] of Object.entries(doc.targetAngles)) angles[e] = P.degToRad(a)
          const mats = P.computeFaceMatrices(doc, tree, angles)
          const pos = new Map(doc.vertices.map((v) => [v.id, v.pos]))
          const polys = doc.faces.map((f) => {
            const e = mats.get(f.id).elements
            return {
              name: f.name,
              layer: f.layer ?? 0,
              pts: f.vertexIds.map((id) => {
                const { x, y } = pos.get(id)
                return [e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13], e[2] * x + e[6] * y + e[14]]
              }),
            }
          })
          const all = polys.flatMap((p) => p.pts)
          const ext = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])) - Math.min(...all.map((p) => p[k])))
          const problems = []
          for (let i = 0; i < polys.length; i++)
            for (let j = i + 1; j < polys.length; j++) {
              const A = polys[i]
              const B = polys[j]
              if (crosses(A.pts, B.pts) || crosses(B.pts, A.pts)) problems.push(`${A.name} ⨯ ${B.name}`)
              else if (coplanarArea(A.pts, B.pts) > 1e-3) {
                if (kind(A.name) === kind(B.name)) problems.push(`${A.name} ≡ ${B.name}`)
                // A hidden flap flat against a visible panel must draw beneath it.
                const hidden = (p) => ['dust', 'tuck', 'glue'].includes(kind(p.name))
                if (hidden(A) !== hidden(B)) {
                  hiddenPairs++
                  const [h, v] = hidden(A) ? [A, B] : [B, A]
                  if (h.layer >= v.layer) problems.push(`${h.name} draws over ${v.name}`)
                }
              }
            }
          const angleSet = [...new Set(Object.values(doc.targetAngles).map((a) => Math.abs(a)))]
          results.push({
            key: `${style}/${order}/${glueSide}/${lidOn}`,
            faces: doc.faces.length,
            hinges: tree.hingeEdgeIds.length,
            ext: ext.map((v) => Math.round(v * 1000) / 1000),
            angleSet,
            problems,
            ok:
              Math.abs(ext[0] - W) < 1e-6 &&
              Math.abs(ext[1] - H) < 1e-6 &&
              Math.abs(ext[2] - D) < 1e-6 &&
              problems.length === 0 &&
              tree.hingeEdgeIds.length === doc.faces.length - 1 &&
              angleSet.every((a) => Math.abs(a - 90) < 0.05),
          })
        }
  results.push({ key: 'hidden flaps checked', hiddenPairs, ok: hiddenPairs >= 16 * 4 })
  return results
})
const geometryOk = geometry.every((r) => r.ok)

// ---- Wizard helpers --------------------------------------------------------------
async function openWizard(file) {
  await page.locator('.menu-label', { hasText: 'File' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item', { hasText: 'Import dieline image' }).click(),
  ])
  await chooser.setFiles(file)
  await page.locator('.fit-modal button.primary', { hasText: 'Next' }).click()
  await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
  await page.waitForTimeout(300)
}
const fitState = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.fit-canvas')
    return { g: JSON.parse(c.dataset.guides), w: Number(c.dataset.imgW), h: Number(c.dataset.imgH) }
  })
/** Drag one guide line (image px) to `target` with the real mouse. */
async function dragGuide(kind, id, target) {
  const box = await page.locator('canvas.fit-canvas').boundingBox()
  const { g, w, h } = await fitState()
  const sx = box.width / w
  const sy = box.height / h
  // Grab x-guides 30% down the body, y-guides 30% into the first column —
  // away from other guides and the whole-grid handles.
  const yGrab = g.y.bodyH + (g.y.body0 - g.y.bodyH) * 0.3
  const xGrab = g.x.c0 + (g.x.c1 - g.x.c0) * 0.3
  const from = kind === 'x' ? [g.x[id], yGrab] : [xGrab, g.y[id]]
  const to = kind === 'x' ? [target, yGrab] : [xGrab, target]
  await page.mouse.move(box.x + from[0] * sx, box.y + from[1] * sy)
  await page.mouse.down()
  await page.mouse.move(box.x + to[0] * sx, box.y + to[1] * sy, { steps: 5 })
  await page.mouse.up()
}
async function foldedShot(name) {
  await page.evaluate(() => {
    const st = window.paperSim.store.getState()
    st.setAnglesTransient({ ...st.doc.targetAngles })
    window.paperSim.store.getState().rotateObject('x', 90)
  })
  await page.waitForTimeout(700)
  await page.screenshot({ path: SHOTS + name })
}
const pdfText = async () => {
  const P = window.paperSim
  const st = P.store.getState()
  const pdf = await P.dielinePDFTrueScale(st.doc, st.projectName, st.material, st.uvEdits)
  const bytes = new Uint8Array(await pdf.arrayBuffer())
  let text = ''
  for (let i = 0; i < bytes.length; i += 65536) text += String.fromCharCode(...bytes.subarray(i, i + 65536))
  return {
    pages: (text.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
    mediaBox: (text.match(/\/MediaBox \[([^\]]+)\]/) ?? [])[1],
    footer: (text.match(/\((folds to[^)]*)\)/) ?? [])[1],
  }
}

// ---- 2. Wizard on #126 (cherry cloud) ------------------------------------------
// Measured on the picture (1024×1536 px): narrow panel first, glue right,
// top lid on the 1st wide panel, bottom lid on the 2nd (reverse tuck).
const CHERRY_GUIDES = {
  x: { c0: 78, c1: 277, c2: 522, c3: 715, c4: 897, glue: 945 },
  y: { topTuck: 128, bodyH: 408, body0: 1167, botTuck: 1440 },
}
await openWizard(CHERRY)
const guessed = await fitState()
const guessedOptions = await page.evaluate(() =>
  [...document.querySelectorAll('.fit-modal button.active[data-opt]')].map((b) => b.dataset.opt).sort(),
)
for (const [id, v] of Object.entries(CHERRY_GUIDES.x)) await dragGuide('x', id, v)
for (const [id, v] of Object.entries(CHERRY_GUIDES.y)) await dragGuide('y', id, v)
await page.locator('[data-testid=fit-height]').fill('12')
await page.waitForTimeout(300)
const dragged = (await fitState()).g
const dragErr = Math.max(
  ...Object.entries(CHERRY_GUIDES.x).map(([id, v]) => Math.abs(dragged.x[id] - v)),
  ...Object.entries(CHERRY_GUIDES.y).map(([id, v]) => Math.abs(dragged.y[id] - v)),
)
await page.locator('.fit-modal').screenshot({ path: SHOTS + 'v13-wizard-cherry.png' })
await page.locator('.fit-modal button.primary', { hasText: 'Build box' }).click()
await page.waitForFunction(() => !document.querySelector('.fit-modal'))
await page.waitForTimeout(500)

const cherry = await page.evaluate(async (pdfTextSrc) => {
  const P = window.paperSim
  const st = P.store.getState()
  const fs = st.fitSession
  const doc = st.doc
  const { min, max } = P.sheetBounds(doc)
  const sw = max.x - min.x
  const sh = max.y - min.y
  const load = async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    c.getContext('2d').drawImage(img, 0, 0)
    return c
  }
  const mean = (c, x, y, r) => {
    const d = c.getContext('2d').getImageData(Math.round(x - r), Math.round(y - r), 2 * r + 1, 2 * r + 1).data
    const out = [0, 0, 0]
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) out[k] += d[i + k]
    return out.map((v) => Math.round(v / (d.length / 4)))
  }
  const center = (name) => {
    const f = doc.faces.find((q) => q.name === name)
    const ps = f.vertexIds.map((id) => doc.vertices.find((v) => v.id === id).pos)
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length }
  }
  // Registration: the 3D texture at a flat point shows the picture pixel the guides map it to.
  const sheet = await P.buildSheetCanvas(doc, st.material)
  const pic = await load(fs.image)
  const k = fs.heightCm / (fs.guides.y.body0 - fs.guides.y.bodyH) // cm per picture px
  const texR = 3
  const srcR = Math.max(1, Math.round(((texR * sw) / sheet.width) / k))
  const reg = {}
  for (const name of ['front', 'right side', 'front top lid']) {
    const p = center(name)
    const tex = mean(sheet, ((p.x - min.x) / sw) * sheet.width, ((max.y - p.y) / sh) * sheet.height, texR)
    const src = mean(pic, fs.guides.x.c0 + p.x / k, fs.guides.y.body0 - p.y / k, srcR)
    reg[name] = { tex, src, diff: tex.reduce((s, v, i) => s + Math.abs(v - src[i]), 0) }
  }
  // Print bleed: just outside a cut edge = art; far outside = blank paper.
  const print = await P.buildPrintCanvas(doc, st.material, st.uvEdits)
  const back = center('back')
  const px = (x, y) => [((x - min.x) / sw) * print.width, ((max.y - y) / sh) * print.height]
  const H = fs.params.height
  const bleed = {
    inside: mean(print, ...px(back.x, H - 0.1), 1),
    justOutside: mean(print, ...px(back.x, H + 0.1), 1),
    farOutside: mean(print, ...px(back.x, H + 1.0), 1),
  }
  return {
    names: doc.faces.map((f) => f.name).filter((n) => /lid|tuck/.test(n)),
    params: fs.params,
    reg,
    bleed,
    steps: st.steps.map((x) => x.name),
    pdf: await new Function(`return (${pdfTextSrc})()`)(),
  }
}, pdfText.toString())
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b)
// Expected from the measured guides at H = 12 cm (k = 12 / 759 cm per px).
const kC = 12 / (1167 - 408)
const expW = ((245 + 182) / 2) * kC
const expD = ((199 + 193) / 2) * kC
const expTuck = ((408 - 128) * kC - expD + (1440 - 1167) * kC - expD) / 2
const cp = cherry.params
const lum3 = (c) => c[0] + c[1] + c[2]
const cherryChecks = {
  drag: dragErr <= 3,
  layout: cp.style === 'reverse' && cp.order === 'side-first' && cp.glueSide === 'right' && (cp.lidOn ?? 'first') === 'first',
  dims:
    near(cp.width, expW, 0.02) && near(cp.depth, expD, 0.02) && Math.abs(cp.height - 12) < 1e-6 &&
    near(cp.tuck, expTuck, 0.05) && near(cp.glue, 48 * kC, 0.1),
  lids: cherry.names.includes('front top lid') && cherry.names.includes('back bottom lid'),
  registration: Object.values(cherry.reg).every((r) => r.diff < 36),
  bleed:
    lum3(cherry.bleed.justOutside) < 700 &&
    Math.abs(lum3(cherry.bleed.justOutside) - lum3(cherry.bleed.inside)) < 60 &&
    lum3(cherry.bleed.farOutside) >= 760,
  steps: cherry.steps.length === 5,
  pdf: cherry.pdf.pages === 1 && /dpi/.test(cherry.pdf.footer ?? '') && /cut solid lines, score dashed lines/.test(cherry.pdf.footer ?? ''),
}
const cherryOk = Object.values(cherryChecks).every(Boolean)
await page.screenshot({ path: SHOTS + 'v13-cherry-flat.png' })

// Re-fit reopens the same picture + guides on the Fit step.
await page.locator('.menu-label', { hasText: 'File' }).click()
await page.locator('.menu-item', { hasText: 'Re-fit dieline image' }).click()
await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
const refit = (await fitState()).g
const refitOk = Math.max(...Object.keys(dragged.x).map((id) => Math.abs(refit.x[id] - dragged.x[id]))) < 1e-6
await page.locator('.fit-modal button', { hasText: 'Cancel' }).click()
await savePdf('v13-cherry-126.pdf')
await foldedShot('v13-cherry-folded.png')

// ---- 2b. #118 (Hello Kitty juice): horizontal, narrow first, glue LEFT, straight
// tuck — layout from the auto-guess, guides dragged to measured positions — and
// #107 (salted butter) straight from the auto-guess. Both leave a print-ready
// PDF in print/ (gitignored) for the real fold test.
async function savePdf(name) {
  const b64 = await page.evaluate(async () => {
    const P = window.paperSim
    const st = P.store.getState()
    const blob = await P.dielinePDFTrueScale(st.doc, st.projectName, st.material, st.uvEdits)
    const u8 = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < u8.length; i += 65536) s += String.fromCharCode(...u8.subarray(i, i + 65536))
    return btoa(s)
  })
  mkdirSync(PRINT, { recursive: true })
  writeFileSync(PRINT + name, Buffer.from(b64, 'base64'))
}
const KITTY_GUIDES = {
  x: { glue: 180, c0: 255, c1: 367, c2: 627, c3: 733, c4: 995 },
  y: { topTuck: 43, bodyH: 227, body0: 597, botTuck: 780 },
}
await openWizard(KITTY)
const kittyOptions = await page.evaluate(() =>
  [...document.querySelectorAll('.fit-modal button.active[data-opt]')].map((b) => b.dataset.opt).sort(),
)
for (const [id, v] of Object.entries(KITTY_GUIDES.x)) await dragGuide('x', id, v)
for (const [id, v] of Object.entries(KITTY_GUIDES.y)) await dragGuide('y', id, v)
await page.waitForTimeout(300)
await page.locator('.fit-modal').screenshot({ path: SHOTS + 'v13-wizard-kitty.png' })
await page.locator('.fit-modal button.primary', { hasText: 'Build box' }).click()
await page.waitForFunction(() => !document.querySelector('.fit-modal'))
await page.waitForTimeout(500)
const kitty = await page.evaluate(async (pdfTextSrc) => {
  const st = window.paperSim.store.getState()
  return { params: st.fitSession.params, pdf: await new Function(`return (${pdfTextSrc})()`)() }
}, pdfText.toString())
await savePdf('v13-kitty-118.pdf')
await foldedShot('v13-kitty-folded.png')
const kittyOk =
  kittyOptions.join() === 'glueSide=left,style=straight,topLid=2' &&
  kitty.params.glueSide === 'left' && kitty.params.style === 'straight' && kitty.pdf.pages === 1

await openWizard(BUTTER)
await page.locator('.fit-modal').screenshot({ path: SHOTS + 'v13-wizard-butter.png' })
await page.locator('.fit-modal button.primary', { hasText: 'Build box' }).click()
await page.waitForFunction(() => !document.querySelector('.fit-modal'))
await page.waitForTimeout(500)
const butter = await page.evaluate(async (pdfTextSrc) => {
  const st = window.paperSim.store.getState()
  return { params: st.fitSession.params, pdf: await new Function(`return (${pdfTextSrc})()`)() }
}, pdfText.toString())
await savePdf('v13-butter-107.pdf')
await foldedShot('v13-butter-folded.png')
const butterOk = butter.pdf.pages === 1

// #791 (Labubu): aged-paper background with a dark vignette, unprinted dust
// flaps drawn only as outlines, four EQUAL columns (square box). The auto-guess
// must keep the vignette out of the drawing, put the body top at the body (not
// the lid), and read the lid panels (1st and 3rd, reverse) from the flaps.
// Expected positions measured on the picture, as fractions of its size.
const LABUBU_FRAC = {
  x: { glue: 0.0325, c0: 0.0625, c1: 0.2917, c2: 0.5166, c3: 0.7414, c4: 0.9663 },
  y: { topTuck: 0.159, bodyH: 0.3685, body0: 0.6325, botTuck: 0.84 },
}
await openWizard(LABUBU)
await page.locator('.fit-modal').screenshot({ path: SHOTS + 'v13-wizard-labubu.png' })
const labubuFit = await fitState()
const labubuOptions = await page.evaluate(() =>
  [...document.querySelectorAll('.fit-modal button.active[data-opt]')].map((b) => b.dataset.opt).sort(),
)
const labubuErr = Math.max(
  ...Object.entries(LABUBU_FRAC.x).map(([id, f]) => Math.abs(labubuFit.g.x[id] / labubuFit.w - f)),
  ...Object.entries(LABUBU_FRAC.y).map(([id, f]) => Math.abs(labubuFit.g.y[id] / labubuFit.h - f)),
)
await page.locator('.fit-modal button.primary', { hasText: 'Build box' }).click()
await page.waitForFunction(() => !document.querySelector('.fit-modal'))
await page.waitForTimeout(500)
const labubu = await page.evaluate(() => {
  const p = window.paperSim.store.getState().fitSession.params
  return { width: p.width, depth: p.depth, height: p.height }
})
await foldedShot('v13-labubu-folded.png')
const labubuOk =
  labubuErr < 0.015 &&
  labubuOptions.join() === 'glueSide=left,style=reverse,topLid=1' &&
  Math.abs(labubu.height / labubu.width - 1.43) < 0.08 &&
  Math.abs(labubu.width / labubu.depth - 1) < 0.05

// ---- 3. Gable regression: #110 through the same wizard ----------------------------
await openWizard(MILK)
await page.locator('.fit-modal button[data-arch=gable]').click()
await page.waitForTimeout(300)
await page.locator('.fit-modal').screenshot({ path: SHOTS + 'v13-wizard-milk.png' })
await page.locator('.fit-modal button.primary', { hasText: 'Build box' }).click()
await page.waitForFunction(() => !document.querySelector('.fit-modal'))
await page.waitForTimeout(500)
const milk = await page.evaluate(async (pdfTextSrc) => {
  const st = window.paperSim.store.getState()
  return {
    gable: st.doc.faces.some((f) => f.name === 'front roof'),
    overlay: !!st.material.overlayImage && !!st.material.overlayTransform,
    archetype: st.fitSession?.archetype,
    steps: st.steps.length,
    pdf: await new Function(`return (${pdfTextSrc})()`)(),
  }
}, pdfText.toString())
const milkOk = milk.gable && milk.overlay && milk.archetype === 'gable' && milk.steps === 3 && milk.pdf.pages === 1
await foldedShot('v13-milk-folded.png')

// ---- 4. Trace-anything: backdrop → artwork ------------------------------------------
await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.newDocument('tuckbox', { width: 6, depth: 3, height: 9, style: 'reverse', order: 'front-first', glueSide: 'right' })
  window.paperSim.store.getState().setEditorMode('pattern')
})
await page.waitForTimeout(300)
await page.locator('button', { hasText: '📐 Trace' }).click()
const backdrop = await page.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 40
  c.height = 30
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#3a7'
  ctx.fillRect(0, 0, 40, 30)
  const bg = { image: c.toDataURL('image/png'), x: -1, y: 20, w: 20, h: 15, opacity: 0.5 }
  window.paperSim.store.getState().setBackdrop(bg)
  return bg
})
await page.locator('[data-testid=backdrop-as-art]').click()
const traced = await page.evaluate((bg) => {
  const P = window.paperSim
  const st = P.store.getState()
  const { min, max } = P.sheetBounds(st.doc)
  const t = st.material.overlayTransform
  // The overlay rect, back in flat coords, must be the backdrop rect.
  return {
    sameImage: st.material.overlayImage === bg.image,
    x: min.x + t.offsetX * (max.x - min.x),
    top: max.y - t.offsetY * (max.y - min.y),
    w: t.scaleX * (max.x - min.x),
    h: t.scaleY * (max.y - min.y),
  }
}, backdrop)
const tracedOk =
  traced.sameImage &&
  Math.abs(traced.x - backdrop.x) < 1e-9 && Math.abs(traced.top - backdrop.y) < 1e-9 &&
  Math.abs(traced.w - backdrop.w) < 1e-9 && Math.abs(traced.h - backdrop.h) < 1e-9
await page.evaluate(() => window.paperSim.store.getState().setEditorMode('3d'))

// A default tuck box, folded, for the record.
await page.evaluate(() => window.paperSim.store.getState().newDocument('tuckbox'))
await foldedShot('v13-tuckbox-folded.png')

const result = {
  geometry: geometry.filter((r) => !r.ok).length ? geometry : `${geometry.length - 1} variants + detector self-test ok`,
  geometryOk,
  hiddenFlapPairs: geometry.find((r) => r.key === "hidden flaps checked").hiddenPairs,
  guessed: { guides: guessed.g, options: guessedOptions },
  dragErr,
  cherry,
  cherryChecks,
  refitOk,
  kitty: { options: kittyOptions, ...kitty },
  kittyOk,
  butter,
  butterOk,
  labubu: { ...labubu, options: labubuOptions, maxGuideErr: labubuErr },
  labubuOk,
  milk,
  milkOk,
  traced,
  tracedOk,
  pageErrors,
}
const ok = geometryOk && cherryOk && refitOk && kittyOk && butterOk && labubuOk && milkOk && tracedOk && pageErrors.length === 0
console.log(JSON.stringify({ ...result, ok }, null, 2))
await browser.close()
process.exit(ok ? 0 : 1)
