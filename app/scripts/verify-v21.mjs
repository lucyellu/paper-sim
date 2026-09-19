// v21 checks — library trash, run against the local disk database (throwaway
// namespace, purged at the end) and the IndexedDB fallback:
//  1. Delete moves an entry to the Trash tab without a confirm; the open
//     project is unlinked; the count badge shows 1.
//  2. Undo brings it back and re-links the open project.
//  3. Restore from the Trash tab brings it back.
//  4. Trashed entries survive a reload and keep their data (disk: trashed_at
//     set, data kept, not a tombstone).
//  5. Delete forever (confirm) leaves a tombstone; Empty trash clears the rest.
//  6. Entries trashed more than 30 days ago are deleted for good when the
//     gallery opens; younger ones stay.
// Usage: node scripts/verify-v21.mjs (dev server running)
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const SHOTS = fileURLToPath(new globalThis.URL('./shots/', import.meta.url))
const RUN = `verify-v21-${Date.now().toString(36)}`
const DAY = 24 * 60 * 60 * 1000
const browser = await chromium.launch()
const pageErrors = []
let context, page
let dialogs = []

async function start(prefs) {
  context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await context.addInitScript((p) => {
    if (localStorage.getItem('verify.prefsSet')) return
    localStorage.setItem('verify.prefsSet', '1')
    for (const [k, v] of Object.entries(p)) {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    }
  }, prefs)
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    d.accept()
  })
  await page.goto(URL)
  await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
}
const diskList = (ns) =>
  fetch(`${URL}api/library?all=1`, { headers: { 'x-papersim-ns': ns } }).then((r) => r.json())
const purge = (ns) => fetch(`${URL}api/library`, { method: 'DELETE', headers: { 'x-papersim-ns': ns } })
const libraryId = () => page.evaluate(() => window.paperSim.store.getState().libraryId)
async function openLibrary() {
  await page.locator('.menu-label', { hasText: 'File' }).click()
  await page.locator('.menu-item', { hasText: 'Library…' }).click()
  await page.waitForSelector('.lib-modal')
  await page.waitForFunction(() => !document.querySelector('.lib-modal')?.textContent?.includes('Loading…'))
}
const closeLibrary = () => page.locator('.lib-modal button', { hasText: 'Close' }).click()
const tab = (name) => page.locator('.lib-filter button', { hasText: name }).click()
const cardIds = () => page.$$eval('.lib-card', (els) => els.map((el) => el.dataset.libId))
const trashCount = async () => {
  const badge = page.locator('.lib-trash-tab .lib-count')
  return (await badge.count()) ? Number(await badge.innerText()) : 0
}
const waitCards = (n) => page.waitForFunction((n) => document.querySelectorAll('.lib-card').length === n, n)
async function save() {
  await page.keyboard.press('Control+s')
  await page.waitForSelector('.topbar-toast:has-text("Saved to library")', { timeout: 15000 })
  await page.waitForSelector('.topbar-toast', { state: 'detached', timeout: 5000 })
  return libraryId()
}

async function suite(mode, ns) {
  const out = {}
  const boxId = await save()
  await page.evaluate(() => window.paperSim.store.getState().newDocument('gable'))
  const gableId = await save()

  // 1. Delete → trash, no confirm, open project unlinked.
  await openLibrary()
  dialogs = []
  await page.locator(`.lib-card[data-lib-id="${gableId}"]`).click()
  await page.locator('.lib-modal button', { hasText: 'Delete' }).click()
  await waitCards(1)
  out.noConfirm = dialogs.length === 0
  out.goneFromAll = !(await cardIds()).includes(gableId)
  out.unlinked = (await libraryId()) === null
  out.badge1 = (await trashCount()) === 1
  out.undoShown = (await page.locator('.lib-undo').count()) === 1

  // 2. Undo.
  await page.locator('.lib-undo button', { hasText: 'Undo' }).click()
  await waitCards(2)
  out.undoRestores = (await cardIds()).includes(gableId) && (await trashCount()) === 0
  out.undoRelinks = (await libraryId()) === gableId

  // 3. Delete via keyboard, restore from the Trash tab.
  await page.locator(`.lib-card[data-lib-id="${gableId}"]`).focus()
  await page.keyboard.press('Delete')
  await waitCards(1)
  await tab('Trash')
  await waitCards(1)
  out.inTrashTab = (await cardIds())[0] === gableId
  out.trashSub = /deleted/.test(await page.locator('.lib-card .new-card-sub').innerText())
  out.trashNote = /30 days/.test(await page.locator('.lib-trash-note').innerText())
  await page.screenshot({ path: SHOTS + `v21-trash-${mode}.png` })
  await page.locator(`.lib-card[data-lib-id="${gableId}"]`).click()
  await page.locator('.lib-modal button', { hasText: 'Restore' }).click()
  await waitCards(0)
  out.trashEmptyNote = /empty/.test(await page.locator('.lib-trash-note').innerText())
  await tab('All')
  await waitCards(2)
  out.restored = (await cardIds()).includes(gableId)

  // 4. Trash both, reload: still in the trash, data intact.
  for (const id of [gableId, boxId]) {
    await page.locator(`.lib-card[data-lib-id="${id}"]`).click()
    await page.locator('.lib-modal button', { hasText: 'Delete' }).click()
  }
  await waitCards(0)
  await closeLibrary()
  await page.reload()
  await page.waitForFunction(() => window.paperSim && window.paperSimViewer)
  await openLibrary()
  out.emptyAfterReload = (await cardIds()).length === 0 && (await trashCount()) === 2
  out.dataKept = await page.evaluate(async (ids) => {
    const got = await Promise.all(ids.map((id) => window.paperSim.library.getLibraryData(id)))
    window.__file = got[0]?.file // a valid payload for seeding step 6
    return got.every((d) => !!d?.file)
  }, [gableId, boxId])
  if (mode === 'disk') {
    const rows = await diskList(ns)
    out.diskTrashed = rows.length === 2 && rows.every((m) => m.trashedAt && !m.deletedAt)
  }

  // 5. Delete forever one, empty trash for the other.
  await tab('Trash')
  await waitCards(2)
  dialogs = []
  await page.locator(`.lib-card[data-lib-id="${boxId}"]`).click()
  await page.locator('.lib-modal button', { hasText: 'Delete forever' }).click()
  await waitCards(1)
  out.foreverConfirms = dialogs.length === 1 && /can't be undone/.test(dialogs[0])
  await page.locator('.lib-modal button', { hasText: 'Empty trash' }).click()
  await waitCards(0)
  out.emptyConfirms = dialogs.length === 2
  out.badgeGone = (await trashCount()) === 0
  const all = await page.evaluate(() => window.paperSim.library.listAllLibrary())
  out.tombstones = all.length === 2 && all.every((m) => m.deletedAt && !m.trashedAt)
  await closeLibrary()

  // 6. Expiry: 31 days in the trash goes, 29 days stays.
  await page.evaluate(
    async (DAY) => {
      const L = window.paperSim.library
      const f = window.__file
      const now = Date.now()
      const put = (id, days) =>
        L.putLibraryEntry(
          { id, name: id, kind: 'project', createdAt: now - 40 * DAY, updatedAt: now - days * DAY, trashedAt: now - days * DAY },
          { id, file: f },
          { quiet: true },
        )
      await put('old', 31)
      await put('young', 29)
    },
    DAY,
  )
  await openLibrary()
  await tab('Trash')
  await waitCards(1)
  out.expiredPurged = JSON.stringify(await cardIds()) === '["young"]'
  const old = (await page.evaluate(() => window.paperSim.library.listAllLibrary())).find((m) => m.id === 'old')
  out.expiredTombstoned = !!old?.deletedAt
  await closeLibrary()
  return out
}

const results = {}
const nsDisk = `${RUN}-disk`
const nsBrowser = `${RUN}-browser`
try {
  await start({ 'paperSim.libraryNs': nsDisk, 'paperSim.libraryBackend': null })
  results.disk = await suite('disk', nsDisk)
  await context.close()
  await start({ 'paperSim.libraryNs': nsBrowser, 'paperSim.libraryBackend': 'browser' })
  results.browser = await suite('browser', nsBrowser)
  results.browser.nothingOnDisk = (await diskList(nsBrowser)).length === 0
  await context.close()
} finally {
  await purge(nsDisk)
  await purge(nsBrowser)
}
results.pageErrors = pageErrors
const flat = [results.disk, results.browser].flatMap((o) => Object.values(o ?? {}))
results.ok = pageErrors.length === 0 && flat.every((v) => typeof v !== 'boolean' || v)
console.log(JSON.stringify(results, null, 2))
await browser.close()
process.exit(results.ok ? 0 : 1)
