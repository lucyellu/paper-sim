// Verifies the dieline wizard on #767 (JUICE face oil): a mockup that draws
// three panels flat and the 4th + glue flap folded back in perspective, with
// the top lid on panel 2 and a separate logo below the dieline.
//  1. Prep: the logo is outside the one dieline → the dieline is picked and
//     the logo painted out (the baked picture is the dieline + margin).
//  2. Fit guess: every guide on its crease (body top/bottom are NOT the dust
//     flap tips), top lid on panel 2, reverse tuck, panel 4 folded away, and
//     no panel-mismatch warning.
//  3. Build: the box has the front's width (not the folded panel's), and the
//     folded-away panel and its lid print plain paper (not the black
//     background).
//  4. "All 4 panels" brings back the half-width panel (mismatch warning), and
//     the lid toggles set the builder params directly.
//  5. Re-fit reopens with the folded-away setting.
// Screenshots land in scripts/shots/.
// Usage: node scripts/verify-v17.mjs   (dev server must be running; needs the
// local-only reference/dieline/ pictures)
import { chromium } from 'playwright'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const REF = (name) => fileURLToPath(new globalThis.URL(`../../reference/dieline/${name}`, import.meta.url))
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
const JUICE = REF('pinterest_4081455908182767.jpg')
if (!existsSync(JUICE)) {
  console.error(`test image missing: ${JUICE}`)
  process.exit(1)
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

const results = []
const check = (key, ok, info = '') => results.push({ key, ok: !!ok, info })
const fitState = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.fit-canvas')
    return {
      w: Number(c.dataset.imgW),
      h: Number(c.dataset.imgH),
      g: JSON.parse(c.dataset.guides),
      opts: [...document.querySelectorAll('.fit-modal button.active[data-opt]')].map((b) => b.dataset.opt).sort(),
      folded: document.querySelector('.fit-modal button.active[data-folded]')?.dataset.folded,
      mismatch: !!document.querySelector('[data-testid=fit-mismatch]'),
    }
  })

// ---- 1. Prep ------------------------------------------------------------------------
await page.locator('.menu-label', { hasText: 'File' }).click()
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.locator('.menu-item', { hasText: 'Import dieline image' }).click(),
])
await chooser.setFiles(JUICE)
await page.waitForFunction(() => document.querySelector('canvas.prep-canvas')?.width > 10, null, { timeout: 20000 })
await page.waitForTimeout(400)
const prep = await page.evaluate(() => ({
  pieces: JSON.parse(document.querySelector('canvas.prep-canvas').dataset.pieces),
  picked: !!document.querySelector('[data-testid=picked-piece]'),
}))
check('prep: one drawing, picked (logo outside it)', prep.pieces.length === 1 && prep.picked, JSON.stringify(prep))
await page.locator('.fit-modal button.primary', { hasText: 'Next' }).click()
await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
await page.waitForTimeout(400)

// ---- 2. Fit guess ----------------------------------------------------------------------
const fit = await fitState()
// The dieline spans x 155–1307, y 52–1708 of the 1440 × 1800 picture.
check('prep: baked = dieline + margin', fit.w < 1260 && fit.h < 1760 && fit.w > 1152 && fit.h > 1656, `${fit.w}×${fit.h}`)
// Creases measured on the picture; the crop origin comes from c0 (the dieline's left edge, x 159).
const originX = 159 - fit.g.x.c0
const originY = 430 - fit.g.y.bodyH
const expected = {
  x: { c1: 484, c2: 831, c3: 1147 },
  y: { topTuck: 55, body0: 1316, botTuck: 1706 },
}
const off = []
for (const axis of ['x', 'y'])
  for (const [id, want] of Object.entries(expected[axis])) {
    const got = fit.g[axis][id] + (axis === 'x' ? originX : originY)
    if (Math.abs(got - want) > 10) off.push(`${id} ${Math.round(got)} vs ${want}`)
  }
// Body top: the crease under the flaps (≈430), not the dust flap tips (≈230).
const bodyTopAbs = fit.g.y.bodyH + (52 - 25) // crop margin ≈ 25 px above the lid top at y 52
check('fit: body top on the crease, not the flap tips', Math.abs(bodyTopAbs - 430) < 12, String(Math.round(bodyTopAbs)))
check('fit: guides on the creases (±10 px)', off.length === 0, off.join(', '))
check('fit: top lid on panel 2, reverse tuck', fit.opts.join() === 'glueSide=right,style=reverse,topLid=2', fit.opts.join())
check('fit: panel 4 folded away', fit.folded === 'last', fit.folded)
check('fit: no panel mismatch warning', !fit.mismatch)
const view = await page.evaluate(() => {
  const c = document.querySelector('canvas.fit-canvas')
  return { viewW: Number(c.dataset.viewW), imgW: Number(c.dataset.imgW) }
})
check('fit: view widened to show the copied panel', view.viewW > view.imgW, JSON.stringify(view))
await page.locator('.fit-modal').screenshot({ path: SHOTS + 'v17-juice-fit.png' })

// ---- 4 (before building). Toggles --------------------------------------------------------
await page.locator('[data-folded=none]').click()
await page.waitForTimeout(200)
check('toggle: all 4 panels → mismatch warning (half-width panel 4)', (await fitState()).mismatch)
await page.locator('[data-folded=last]').click()
await page.locator('[data-opt="topLid=3"]').click()
await page.waitForTimeout(200)
const lidTo3 = await fitState()
check(
  'toggle: top lid → panel 3 keeps the columns and the bottom label follows',
  lidTo3.opts.includes('topLid=3') &&
    Math.abs(lidTo3.g.x.c2 - fit.g.x.c2) < 0.01 &&
    (await page.locator('[data-opt="style=reverse"]').textContent()).includes('Panel 1'),
  lidTo3.opts.join(),
)
await page.locator('[data-opt="topLid=2"]').click()
await page.waitForTimeout(200)

// ---- 3. Build ------------------------------------------------------------------------
await page.locator('.fit-modal button.primary', { hasText: 'Build box' }).click()
await page.waitForFunction(() => !document.querySelector('.fit-modal'))
await page.waitForTimeout(800)
const built = await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  const p = st.fitSession.params
  return { p, folded: st.fitSession.folded, faces: st.doc.faces.map((f) => f.name) }
})
// Picture: front 347 px wide, sides 325 / 314, body 886 tall.
const { p } = built
check(
  'build: side-first reverse tuck, lid on the front',
  p.order === 'side-first' && p.lidOn === 'first' && p.style === 'reverse',
  JSON.stringify(p),
)
check(
  'build: proportions from the flat panels (W/D ≈ 1.09, H/W ≈ 2.55)',
  Math.abs(p.width / p.depth - 1.09) < 0.08 && Math.abs(p.height / p.width - 2.55) < 0.15,
  `W/D ${(p.width / p.depth).toFixed(2)} H/W ${(p.height / p.width).toFixed(2)}`,
)

const print = await page.evaluate(async () => {
  const P = window.paperSim
  const st = P.store.getState()
  const doc = st.doc
  const canvas = await P.buildPrintCanvas(doc, st.material, st.uvEdits)
  const ctx = canvas.getContext('2d')
  const { min, max } = P.sheetBounds(doc)
  const lum = (name) => {
    const f = doc.faces.find((q) => q.name === name)
    const pts = f.vertexIds.map((id) => doc.vertices.find((v) => v.id === id).pos)
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length
    const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length
    const x = Math.round(((cx - min.x) / (max.x - min.x)) * canvas.width)
    const y = Math.round((1 - (cy - min.y) / (max.y - min.y)) * canvas.height)
    const d = ctx.getImageData(x - 3, y - 3, 7, 7).data
    let s = 0
    for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    return Math.round(s / (d.length / 4))
  }
  return {
    back: lum('back'),
    backLid: lum('back bottom lid'),
    front: lum('front'),
    url: canvas.toDataURL('image/png'),
  }
})
writeFileSync(SHOTS + 'v17-juice-print.png', Buffer.from(print.url.split(',')[1], 'base64'))
check(
  'print: folded-away panel and its lid are plain paper, not background',
  print.back > 170 && print.backLid > 170,
  `back ${print.back}, back bottom lid ${print.backLid}, front ${print.front}`,
)
check('session: folded-away saved', built.folded === 'last', String(built.folded))

await page.evaluate(() => {
  const st = window.paperSim.store.getState()
  st.setAnglesTransient({ ...st.doc.targetAngles })
  window.paperSim.store.getState().rotateObject('x', 90)
})
await page.waitForTimeout(700)
await page.screenshot({ path: SHOTS + 'v17-juice-folded.png' })

// ---- 5. Re-fit ------------------------------------------------------------------------
await page.locator('.menu-label', { hasText: 'File' }).click()
await page.locator('.menu-item', { hasText: 'Re-fit dieline image' }).click()
await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
await page.waitForTimeout(300)
const refit = await fitState()
check('re-fit: reopens folded away with the same lids', refit.folded === 'last' && refit.opts.join() === fit.opts.join(), JSON.stringify(refit))

await browser.close()
let ok = true
for (const r of results) {
  if (!r.ok) ok = false
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.key}${r.info && !r.ok ? '  ' + r.info : ''}`)
}
if (pageErrors.length) {
  ok = false
  console.log('page errors:', pageErrors)
}
process.exit(ok ? 0 : 1)
