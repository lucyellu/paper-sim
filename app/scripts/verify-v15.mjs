// Verifies multi-drawing dieline pictures in the import wizard's Prep step:
//  1. #908 (Lush: one big dieline + two color variants, crop marks, captions)
//     → 3 drawings found, the big one is picked; clicking a variant picks it
//     instead; clicking back and going on bakes just the big one's box.
//  2. #790 (pudding pot: box dieline + pouch + pot case + legend) → the box
//     dieline is found and picked (biggest), the pouch is a separate drawing.
//  3. The single-dieline pictures verify-v13 fits (#793, #773, #783, #770,
//     #791) are left alone (no drawings list, no crop), so their fits are unchanged.
// Screenshots land in scripts/shots/.
// Usage: node scripts/verify-v15.mjs   (dev server must be running; needs the
// local-only reference/dieline/ pictures)
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const REF = (name) => fileURLToPath(new globalThis.URL(`../../reference/dieline/${name}`, import.meta.url))
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
const LUSH = REF('pinterest_4081455908182781.jpg')
const PUDDING = REF('pinterest_4081455908182790.png')
const SINGLES = [
  'pinterest_4081455908182793.png',
  'pinterest_4081455908182773.png',
  'pinterest_4081455908182783.jpg',
  'pinterest_4081455908182770.jpg',
  'pinterest_4081455908182791.jpg',
].map(REF)
for (const f of [LUSH, PUDDING, ...SINGLES]) {
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

const results = []
const check = (key, ok, info = '') => results.push({ key, ok: !!ok, info })

async function openPrep(file) {
  await page.locator('.menu-label', { hasText: 'File' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item', { hasText: 'Import dieline image' }).click(),
  ])
  await chooser.setFiles(file)
  await page.waitForFunction(() => document.querySelector('canvas.prep-canvas')?.width > 10, null, { timeout: 20000 })
  await page.waitForTimeout(400)
}
const prepState = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.prep-canvas')
    return { pieces: JSON.parse(c.dataset.pieces), picked: Number(c.dataset.picked) }
  })
async function toFit() {
  await page.locator('.fit-modal button.primary', { hasText: 'Next' }).click()
  await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
  await page.waitForTimeout(300)
}
async function cancel() {
  await page.locator('.fit-modal button', { hasText: 'Cancel' }).click()
  await page.waitForTimeout(200)
}
/** Click the middle of drawing `i` on the prep canvas. */
async function clickPiece(i) {
  const box = await page.locator('canvas.prep-canvas').boundingBox()
  const { pieces } = await prepState()
  const imgW = await page.evaluate(() => Number(document.querySelector('canvas.prep-canvas').dataset.imgW))
  const [x, y, pw, ph] = pieces[i]
  const s = box.width / imgW
  await page.mouse.click(box.x + (x + pw / 2) * s, box.y + (y + ph / 2) * s)
  await page.waitForTimeout(200)
}
/** Size of the baked picture the fit step uses. */
const bakedSize = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.fit-canvas')
    return { w: Number(c.dataset.imgW), h: Number(c.dataset.imgH) }
  })

// ---- 1. Lush: three drawings --------------------------------------------------
await openPrep(LUSH)
{
  const { pieces, picked } = await prepState()
  check('lush: 3 drawings', pieces.length === 3, JSON.stringify(pieces))
  check('lush: big one picked', picked === 0 && pieces[0][2] * pieces[0][3] > 3 * pieces[1][2] * pieces[1][3])
  await page.screenshot({ path: SHOTS + 'v15-lush-prep.png' })
  await clickPiece(2)
  const after = await prepState()
  check('lush: click picks a variant', after.picked === 2, `picked ${after.picked}`)
  await page.screenshot({ path: SHOTS + 'v15-lush-variant.png' })
  await clickPiece(0)
  await toFit()
  const { w, h } = await bakedSize()
  const [, , pw, ph] = pieces[0]
  const arch = await page.evaluate(() => document.querySelector('[data-arch].active')?.dataset.arch)
  check('lush: fits as a tuck box (not a cross)', arch === 'tuck', arch)
  check('lush: baked = big drawing + margin', w < pw * 1.1 && h < ph * 1.1 && w > pw && h > ph, `${w}×${h} vs ${pw}×${ph}`)
  await page.screenshot({ path: SHOTS + 'v15-lush-fit.png' })
  await cancel()
}

// ---- 2. Pudding: box + pouch + pot ------------------------------------------------
await openPrep(PUDDING)
{
  const { pieces, picked } = await prepState()
  check('pudding: ≥3 drawings', pieces.length >= 3, JSON.stringify(pieces))
  // The box dieline spans x≈30…975, y≈25…1000 in the 1536×1024 picture.
  const [x, y, w, h] = pieces[0] ?? [0, 0, 0, 0]
  check('pudding: box dieline picked', picked === 0 && x > 10 && x < 60 && x + w < 1000 && w > 850 && h > 900, JSON.stringify(pieces[0]))
  await page.screenshot({ path: SHOTS + 'v15-pudding-prep.png' })
  await toFit()
  await page.screenshot({ path: SHOTS + 'v15-pudding-fit.png' })
  await cancel()
}

// ---- 3. Single-dieline pictures are left alone -----------------------------------
for (const f of SINGLES) {
  await openPrep(f)
  const { pieces, picked } = await prepState()
  const name = f.split(/[\\/]/).pop()
  check(`single: ${name} untouched`, pieces.length <= 1 && picked === -1, JSON.stringify(pieces))
  await cancel()
}

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
console.log(ok ? 'ALL OK' : 'FAILURES')
process.exit(ok ? 0 : 1)
