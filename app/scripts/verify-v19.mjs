// v19 checks — project library, run twice: against the local disk database
// (SQLite via /api/library, in a throwaway namespace that's purged at the end)
// and against the IndexedDB fallback. Then: entries saved in the browser are
// copied to disk once the disk database is reachable.
//  1. Empty library shows the empty state; Ctrl+S saves the current project
//     (toast, libraryId set, 3D JPEG thumbnail); a second save updates it.
//  2. File › Save to library on a different project adds a second entry.
//  3. Double-click a card reopens it (doc + name restored, libraryId set).
//  4. Rename (F2) and Delete (to the trash) work and persist across reloads.
//  5. Import dieline image… auto-adds a 'Dieline import' entry with its fit
//     session; reopening it keeps Re-fit available, and a re-fit updates the
//     same entry instead of adding one.
//  6. The gallery footer says where the library lives.
// Usage: node scripts/verify-v19.mjs (dev server running; step 5 needs the
// local-only reference/dieline/ pictures and is skipped without them)
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const CHERRY = fileURLToPath(new globalThis.URL('../../reference/dieline/pinterest_4081455908182793.png', import.meta.url))
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
const browser = await chromium.launch()
const RUN = `verify-v19-${Date.now().toString(36)}`
const pageErrors = []
let context, page, out

/** Fresh browser context with the library pointed at `ns` (or forced to IndexedDB). */
async function start(prefs) {
  context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await context.addInitScript((p) => {
    // Only on the first load: later reloads keep whatever the test changed.
    if (localStorage.getItem('verify.prefsSet')) return
    localStorage.setItem('verify.prefsSet', '1')
    for (const [k, v] of Object.entries(p)) {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    }
  }, prefs)
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('dialog', (d) => d.accept())
  await page.goto(URL)
  await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
}
/** The disk API as the app sees it, for namespace `ns`. */
const diskList = (ns) =>
  fetch(`${URL}api/library?all=1`, { headers: { 'x-papersim-ns': ns } }).then((r) => r.json())
const purge = (ns) => fetch(`${URL}api/library`, { method: 'DELETE', headers: { 'x-papersim-ns': ns } })
const st = () => page.evaluate(() => {
  const s = window.paperSim.store.getState()
  return { libraryId: s.libraryId, name: s.projectName, faces: s.doc.faces.length, fit: !!s.fitSession }
})
async function openLibrary() {
  await page.locator('.menu-label', { hasText: 'File' }).click()
  await page.locator('.menu-item', { hasText: 'Library…' }).click()
  await page.waitForSelector('.lib-modal')
  await page.waitForFunction(() => !document.querySelector('.lib-modal')?.textContent?.includes('Loading…'))
}
const closeLibrary = () => page.locator('.lib-modal button', { hasText: 'Close' }).click()
const cards = () =>
  page.$$eval('.lib-card', (els) =>
    els.map((el) => ({
      id: el.dataset.libId,
      name: el.querySelector('.new-card-name')?.textContent ?? '',
      sub: el.querySelector('.new-card-sub')?.textContent ?? '',
      thumb: el.querySelector('img')?.getAttribute('src')?.slice(0, 16) ?? null,
      open: !!el.querySelector('.lib-badge'),
    })),
  )
const waitToast = async (text) => {
  await page.waitForSelector(`.topbar-toast:has-text("${text}")`, { timeout: 15000 })
  const t = await page.locator('.topbar-toast').innerText()
  // Let the toast clear so the next wait sees a fresh one.
  await page.waitForSelector('.topbar-toast', { state: 'detached', timeout: 5000 })
  return t
}

async function suite(mode) {
out = {}
// 1. Empty state, Ctrl+S save, re-save updates.
await openLibrary()
out.location = (await page.locator('.lib-where').getAttribute('data-location')) === mode
out.emptyState = (await page.locator('.lib-empty').count()) === 1
await closeLibrary()
await page.keyboard.press('Control+s')
out.ctrlSToast = await waitToast('Saved to library')
const first = await st()
out.ctrlSId = !!first.libraryId
await page.keyboard.press('Control+s')
await waitToast('Saved to library')
out.resaveSameId = (await st()).libraryId === first.libraryId

// 2. A second project through the menu.
await page.evaluate(() => window.paperSim.store.getState().newDocument('gable'))
out.newDocClearsId = (await st()).libraryId === null
await page.locator('.menu-label', { hasText: 'File' }).click()
await page.locator('.menu-item', { hasText: 'Save to library' }).click()
await waitToast('Saved to library')
const gable = await st()

await openLibrary()
const list1 = await cards()
out.twoEntries = list1.length === 2
out.newestFirst = list1[0]?.name === 'milk carton' && list1[1]?.name === 'box'
out.thumbsJpeg = list1.every((c) => c.thumb?.startsWith('data:image/jpeg'))
out.openBadge = list1[0]?.open === true && list1[1]?.open === false

// 3. Reopen the box.
await page.locator(`.lib-card[data-lib-id="${first.libraryId}"]`).dblclick()
await page.waitForSelector('.lib-modal', { state: 'detached' })
const reopened = await st()
out.reopen = reopened.libraryId === first.libraryId && reopened.name === 'box' && reopened.faces === first.faces && reopened.faces !== gable.faces

// 4. Rename (F2) + delete, persisted across reload.
await openLibrary()
await page.locator(`.lib-card[data-lib-id="${first.libraryId}"]`).focus()
await page.keyboard.press('F2')
await page.locator('.lib-rename').fill('Gift box')
await page.keyboard.press('Enter')
await page.waitForFunction((id) => document.querySelector(`.lib-card[data-lib-id="${id}"] .new-card-name`)?.textContent === 'Gift box', first.libraryId)
out.renameFollowsProject = (await st()).name === 'Gift box'
// Escape cancels a rename without committing it.
await page.locator(`.lib-card[data-lib-id="${gable.libraryId}"]`).focus()
await page.keyboard.press('F2')
await page.locator('.lib-rename').fill('SHOULD NOT STICK')
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
out.escapeCancels = (await cards()).find((c) => c.id === gable.libraryId)?.name === 'milk carton'
await page.locator(`.lib-card[data-lib-id="${gable.libraryId}"]`).click()
await page.locator('.lib-modal button', { hasText: 'Delete' }).click()
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 1)
await closeLibrary()
await page.reload()
await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
await openLibrary()
await page.screenshot({ path: SHOTS + `v19-library-${mode}.png` })
const list2 = await cards()
out.persisted = list2.length === 1 && list2[0].name === 'Gift box'
await closeLibrary()

// 5. Dieline import auto-adds; reopen keeps Re-fit; re-fit updates in place.
if (existsSync(CHERRY)) {
  await page.locator('.menu-label', { hasText: 'File' }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item', { hasText: 'Import dieline image' }).click(),
  ])
  await chooser.setFiles(CHERRY)
  await page.locator('.fit-modal button.primary', { hasText: 'Next' }).click()
  await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
  await page.locator('.fit-modal button.primary').last().click()
  out.importToast = await waitToast('Added to library')
  const imported = await st()
  await openLibrary()
  const list3 = await cards()
  const entry = list3.find((c) => c.id === imported.libraryId)
  out.importEntry = list3.length === 2 && !!entry && entry.sub.startsWith('Dieline import') && entry.thumb?.startsWith('data:image/jpeg')
  if (mode === 'disk') await page.screenshot({ path: SHOTS + 'v19-library-import.png' })
  // Switch away, then reopen the import from the library.
  await page.locator(`.lib-card[data-lib-id="${first.libraryId}"]`).dblclick()
  await page.waitForSelector('.lib-modal', { state: 'detached' })
  out.projectHasNoFit = (await st()).fit === false
  await openLibrary()
  await page.locator(`.lib-card[data-lib-id="${imported.libraryId}"]`).dblclick()
  await page.waitForSelector('.lib-modal', { state: 'detached' })
  out.importReopenFit = (await st()).fit === true
  await page.locator('.menu-label', { hasText: 'File' }).click()
  await page.locator('.menu-item', { hasText: 'Re-fit dieline image' }).click()
  await page.waitForFunction(() => document.querySelector('canvas.fit-canvas')?.dataset.guides, null, { timeout: 20000 })
  await page.locator('.fit-modal button.primary').last().click()
  out.refitToast = await waitToast('Library entry updated')
  await openLibrary()
  out.refitSameEntry = (await cards()).length === 2 && (await st()).libraryId === imported.libraryId
  await closeLibrary()
} else {
  out.importSkipped = 'reference/dieline pictures not found'
}
return out
}

const results = {}
const nsDisk = `${RUN}-disk`
const nsMigrate = `${RUN}-migrate`
try {
  // Disk database (throwaway namespace).
  await start({ 'paperSim.libraryNs': nsDisk, 'paperSim.libraryBackend': null })
  results.disk = await suite('disk')
  const rows = await diskList(nsDisk)
  results.disk.rowsOnDisk = rows.filter((m) => !m.deletedAt && !m.trashedAt).length === (existsSync(CHERRY) ? 2 : 1)
  results.disk.trashedKept = rows.some((m) => m.trashedAt && !m.deletedAt)
  await context.close()

  // IndexedDB fallback.
  await start({ 'paperSim.libraryNs': nsMigrate, 'paperSim.libraryBackend': 'browser' })
  results.browser = await suite('browser')
  const inBrowser = await page.evaluate(() => window.paperSim.store.getState().libraryId)
  results.browser.nothingOnDisk = (await diskList(nsMigrate)).length === 0

  // Same browser, disk database now allowed: browser entries are copied over once.
  await page.evaluate(() => localStorage.removeItem('paperSim.libraryBackend'))
  await page.reload()
  await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
  await openLibrary()
  const migrated = await diskList(nsMigrate)
  const live = migrated.filter((m) => !m.deletedAt && !m.trashedAt)
  results.migrate = {
    location: (await page.locator('.lib-where').getAttribute('data-location')) === 'disk',
    copied: live.length === (existsSync(CHERRY) ? 2 : 1) && live.some((m) => m.id === inBrowser),
    shown: (await cards()).length === live.length,
  }
  await context.close()
} finally {
  await purge(nsDisk)
  await purge(nsMigrate)
}
results.purged = (await diskList(nsDisk)).length === 0 && (await diskList(nsMigrate)).length === 0
results.pageErrors = pageErrors
const flat = [results.disk, results.browser, results.migrate].flatMap((o) => Object.values(o ?? {}))
results.ok = pageErrors.length === 0 && results.purged && flat.every((v) => typeof v !== 'boolean' || v)
console.log(JSON.stringify(results, null, 2))
await browser.close()
process.exit(results.ok ? 0 : 1)
