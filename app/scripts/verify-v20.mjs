// v20 checks — cloud library sync engine, against the real local disk
// database (throwaway namespace, purged at the end) and an in-memory fake
// remote standing in for Supabase:
//  1. One pass resolves every case: local-only → pushed, remote-only → pulled,
//     remote tombstone only → ignored, newer side wins both ways, tombstones
//     delete on the other side, equal stamps → untouched.
//  2. A second pass changes nothing (idempotent).
//  3. The gallery shows the pulled entries and the signed-in cloud line.
//  4. Local edits auto-sync: rename and delete in the gallery reach the remote.
//  5. With no remote and no Supabase config the gallery says sync is off.
// Usage: node scripts/verify-v20.mjs (dev server running)
import { chromium } from 'playwright'

const URL = process.env.PAPERSIM_URL ?? 'http://localhost:5173/'
const NS = `verify-v20-${Date.now().toString(36)}`
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
await context.addInitScript((ns) => localStorage.setItem('paperSim.libraryNs', ns), NS)
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('dialog', (d) => d.accept())
const out = {}

try {
  await page.goto(URL)
  await page.waitForFunction(() => window.paperSim && window.paperSimViewer)

  // A real saved project gives us a valid payload to seed the other entries with.
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => window.paperSim.store.getState().libraryId)

  const seeded = await page.evaluate(async () => {
    const L = window.paperSim.library
    const aId = window.paperSim.store.getState().libraryId
    const a = await L.getLibraryMeta(aId)
    const { file } = await L.getLibraryData(aId)
    const T = 1_700_000_000_000
    const meta = (id, name, at, extra = {}) => ({ id, name, kind: 'project', createdAt: T, updatedAt: at, ...extra })
    const data = (id) => ({ id, file })

    // Local side.
    for (const [id, name, at] of [
      ['D', 'D local old', T + 1],
      ['E', 'E local new', T + 9],
      ['F', 'F local', T + 1],
      ['G', 'G local', T + 1],
      ['H', 'H same', T + 5],
    ]) await L.putLibraryEntry(meta(id, name, at), data(id))
    await L.deleteLibraryEntry('G', { at: T + 9 })

    // Remote side: an in-memory stand-in for Supabase.
    const rows = new Map()
    const files = new Map()
    const calls = { put: [], tombstone: [], get: [] }
    const remote = {
      rows,
      calls,
      async listAll() {
        return [...rows.values()].map(({ thumbnail, ...m }) => ({ ...m }))
      },
      async get(id) {
        calls.get.push(id)
        const m = rows.get(id)
        return m && !m.deletedAt ? { meta: { ...m }, data: { id, file: files.get(id) } } : undefined
      },
      async put(m, d) {
        calls.put.push(m.id)
        const { deletedAt, ...live } = m
        rows.set(m.id, { ...live })
        files.set(m.id, d.file)
      },
      async tombstone(id, at) {
        calls.tombstone.push(id)
        const m = rows.get(id)
        rows.set(id, { ...(m ?? { id, name: '', kind: 'project', createdAt: at }), updatedAt: at, deletedAt: at })
        files.delete(id)
      },
    }
    const seed = (m) => {
      rows.set(m.id, m)
      if (!m.deletedAt) files.set(m.id, file)
    }
    seed(meta('B', 'B remote only', T + 3, { thumbnail: a.thumbnail }))
    seed(meta('C', '', T + 3, { deletedAt: T + 3 }))
    seed(meta('D', 'D remote new', T + 9))
    seed(meta('E', 'E remote old', T + 1))
    seed(meta('F', '', T + 9, { deletedAt: T + 9 }))
    seed(meta('G', 'G remote', T + 1))
    seed(meta('H', 'H same', T + 5))
    window.__remote = remote
    return { aId }
  })

  // 1. Signing in (setRemote) runs a sync.
  await page.evaluate(() => window.paperSim.cloud.setRemote(window.__remote, 'fake@example.com'))
  await page.waitForFunction(() => {
    const c = window.paperSim.cloud.useCloud.getState()
    return c.status !== 'syncing' && c.lastSync
  })
  const pass1 = await page.evaluate(async (aId) => {
    const L = window.paperSim.library
    const R = window.__remote
    const c = window.paperSim.cloud.useCloud.getState()
    const local = Object.fromEntries((await L.listAllLibrary()).map((m) => [m.id, m]))
    return {
      status: c.status,
      error: c.error,
      result: c.lastResult,
      local: Object.fromEntries(
        Object.entries(local).map(([id, m]) => [id === aId ? 'A' : id, m.deletedAt ? 'deleted' : m.name]),
      ),
      remote: Object.fromEntries(
        [...R.rows.values()].map((m) => [m.id === aId ? 'A' : m.id, m.deletedAt ? 'deleted' : m.name]),
      ),
      pulledHasData: !!(await L.getLibraryData('B'))?.file?.faces_vertices,
      pulledThumb: !!local.B?.thumbnail,
      calls: { put: R.calls.put.map((id) => (id === aId ? 'A' : id)).sort(), tombstone: R.calls.tombstone, get: R.calls.get.sort() },
    }
  }, seeded.aId)
  out.pass1 = pass1
  out.counts =
    pass1.status === 'idle' &&
    JSON.stringify(pass1.result) === JSON.stringify({ pushed: 2, pulled: 2, deletedLocal: 1, deletedRemote: 1 })
  out.localAfter =
    pass1.local.A === 'box' &&
    pass1.local.B === 'B remote only' &&
    pass1.local.C === undefined &&
    pass1.local.D === 'D remote new' &&
    pass1.local.E === 'E local new' &&
    pass1.local.F === 'deleted' &&
    pass1.local.G === 'deleted' &&
    pass1.local.H === 'H same'
  out.remoteAfter =
    pass1.remote.A === 'box' &&
    pass1.remote.E === 'E local new' &&
    pass1.remote.G === 'deleted' &&
    pass1.remote.C === 'deleted' &&
    pass1.remote.H === 'H same'
  out.onlyNeededCalls =
    JSON.stringify(pass1.calls) === JSON.stringify({ put: ['A', 'E'], tombstone: ['G'], get: ['B', 'D'] })
  out.pulledPayload = pass1.pulledHasData && pass1.pulledThumb

  // 2. Idempotent.
  const pass2 = await page.evaluate(async () => {
    await window.paperSim.cloud.syncWith(window.__remote).then((r) => (window.__r2 = r))
    return window.__r2
  })
  out.idempotent = JSON.stringify(pass2) === JSON.stringify({ pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0 })

  // 3. Gallery.
  await page.locator('.menu-label', { hasText: 'File' }).click()
  await page.locator('.menu-item', { hasText: 'Library…' }).click()
  await page.waitForSelector('.lib-card[data-lib-id="B"]')
  const names = await page.$$eval('.lib-card .new-card-name', (els) => els.map((e) => e.textContent))
  out.galleryShowsSynced =
    names.includes('B remote only') && names.includes('D remote new') && !names.some((n) => /^[FG] /.test(n))
  out.cloudLine = (await page.locator('.lib-cloud').getAttribute('data-cloud')) === 'signed-in'
  out.cloudText = await page.locator('.lib-cloud .hint').first().innerText()
  await page.screenshot({ path: 'scripts/shots/v20-library-cloud.png' })

  // 4. Local edits auto-sync (debounced).
  await page.locator('.lib-card[data-lib-id="B"]').focus()
  await page.keyboard.press('F2')
  await page.locator('.lib-rename').fill('B renamed here')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__remote.rows.get('B')?.name === 'B renamed here', null, { timeout: 10000 })
  out.renamePushed = true
  await page.locator('.lib-card[data-lib-id="H"]').click()
  await page.locator('.lib-modal button', { hasText: 'Delete' }).click()
  await page.waitForFunction(() => !!window.__remote.rows.get('H')?.deletedAt, null, { timeout: 10000 })
  out.deletePushed = true

  // 5. Signed out, not configured → "off".
  await page.evaluate(() => window.paperSim.cloud.setRemote(null))
  await page.waitForSelector('.lib-cloud[data-cloud="off"]')
  out.offLine = true
} finally {
  await fetch(`${URL}api/library`, { method: 'DELETE', headers: { 'x-papersim-ns': NS } })
}

out.pageErrors = pageErrors
out.ok = pageErrors.length === 0 && Object.values(out).every((v) => typeof v !== 'boolean' || v)
console.log(JSON.stringify(out, null, 2))
await browser.close()
process.exit(out.ok ? 0 : 1)
