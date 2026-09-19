// Project library: saved projects and imported dielines/photos.
//
// Primary store: the local SQLite database served at /api/library by the Vite
// server (app/server/libraryServer.mjs) — a file on disk that survives clearing
// the browser. When that API isn't reachable (static hosting), the library
// falls back to the browser's IndexedDB. Entries saved to IndexedDB before the
// disk database existed are copied over once.
//
// Deletes leave tombstones (meta with `deletedAt`) so a cloud sync can pass
// them on; list functions hide them unless asked (`listAllLibrary`).

import type { FitSession } from '../model/dielineFit'
import type { SaveFile } from '../model/foldfile'

/** How the entry got here: saved by hand, or auto-added by an import wizard. */
export type LibraryKind = 'project' | 'dieline' | 'photo'

export interface LibraryMeta {
  id: string
  name: string
  kind: LibraryKind
  createdAt: number
  updatedAt: number
  /** Small PNG/JPEG data URL of the folded model. */
  thumbnail?: string
  /** File name of the imported picture (imports only). */
  sourceName?: string
  /** Set on tombstones (deleted entries kept for sync). */
  deletedAt?: number
}

export interface LibraryData {
  id: string
  file: SaveFile
  /** Dieline imports: the fit, so File › Re-fit works after reopening. */
  fitSession?: FitSession
}

export interface LibraryLocation {
  kind: 'disk' | 'browser'
  /** Database file path (disk only). */
  path?: string
}

interface Backend {
  location: LibraryLocation
  listAll(): Promise<LibraryMeta[]>
  getMeta(id: string): Promise<LibraryMeta | undefined>
  getData(id: string): Promise<LibraryData | undefined>
  put(meta: LibraryMeta, data: LibraryData): Promise<void>
  rename(id: string, name: string, updatedAt: number): Promise<void>
  tombstone(id: string, at: number): Promise<void>
}

// ---- dev/test switches (localStorage) ---------------------------------------
function pref(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
/** Namespace inside the disk database (verify scripts use a throwaway one). */
const NS = () => pref('paperSim.libraryNs') || 'default'
/** 'browser' forces the IndexedDB fallback. */
const FORCE_BROWSER = () => pref('paperSim.libraryBackend') === 'browser'

// ---- disk backend (local API) -----------------------------------------------
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api/library${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-papersim-ns': NS(), ...(init.headers ?? {}) },
  })
  if (!res.ok && res.status !== 404) {
    let msg = `${res.status} ${res.statusText}`
    try {
      msg = (await res.json()).error ?? msg
    } catch {
      // not JSON
    }
    throw new Error(`library server: ${msg}`)
  }
  return res
}

function diskBackend(path: string): Backend {
  return {
    location: { kind: 'disk', path },
    listAll: async () => (await api('?all=1')).json(),
    getMeta: async (id) => {
      const got = await (await api(`/${encodeURIComponent(id)}`)).json()
      return got ? (got.meta as LibraryMeta) : undefined
    },
    getData: async (id) => {
      const got = await (await api(`/${encodeURIComponent(id)}`)).json()
      return got ? { id, file: got.data.file, fitSession: got.data.fitSession ?? undefined } : undefined
    },
    put: async (meta, data) => {
      await api(`/${encodeURIComponent(meta.id)}`, { method: 'PUT', body: JSON.stringify({ meta, data }) })
    },
    rename: async (id, name, updatedAt) => {
      await api(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, updatedAt }) })
    },
    tombstone: async (id, at) => {
      await api(`/${encodeURIComponent(id)}?at=${at}`, { method: 'DELETE' })
    },
  }
}

// ---- browser backend (IndexedDB) --------------------------------------------
const DB_NAME = 'paperSim.library'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('could not open the library database'))
    })
    dbPromise.catch(() => (dbPromise = null))
  }
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('library write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('library write aborted (storage full?)'))
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let persistAsked = false

const browserBackend: Backend = {
  location: { kind: 'browser' },
  listAll: async () => {
    const db = await openDb()
    return request(db.transaction('meta').objectStore('meta').getAll() as IDBRequest<LibraryMeta[]>)
  },
  getMeta: async (id) => {
    const db = await openDb()
    const m = await request(db.transaction('meta').objectStore('meta').get(id) as IDBRequest<LibraryMeta | undefined>)
    return m?.deletedAt ? undefined : m
  },
  getData: async (id) => {
    const db = await openDb()
    return request(db.transaction('data').objectStore('data').get(id) as IDBRequest<LibraryData | undefined>)
  },
  put: async (meta, data) => {
    if (!persistAsked) {
      // Ask the browser not to evict the library under storage pressure.
      persistAsked = true
      void navigator.storage?.persist?.().catch(() => {})
    }
    const db = await openDb()
    const tx = db.transaction(['meta', 'data'], 'readwrite')
    const { deletedAt: _, ...live } = meta
    tx.objectStore('meta').put(live)
    tx.objectStore('data').put(data)
    await txDone(tx)
  },
  rename: async (id, name, updatedAt) => {
    const db = await openDb()
    const tx = db.transaction('meta', 'readwrite')
    const store = tx.objectStore('meta')
    const meta = await request(store.get(id) as IDBRequest<LibraryMeta | undefined>)
    if (meta && !meta.deletedAt) store.put({ ...meta, name, updatedAt })
    await txDone(tx)
  },
  tombstone: async (id, at) => {
    const db = await openDb()
    const tx = db.transaction(['meta', 'data'], 'readwrite')
    const t: LibraryMeta = { id, name: '', kind: 'project', createdAt: at, updatedAt: at, deletedAt: at }
    tx.objectStore('meta').put(t)
    tx.objectStore('data').delete(id)
    await txDone(tx)
  },
}

// ---- backend selection -------------------------------------------------------
let backendPromise: Promise<Backend> | null = null

function backend(): Promise<Backend> {
  if (!backendPromise) backendPromise = pickBackend()
  return backendPromise
}

async function pickBackend(): Promise<Backend> {
  if (FORCE_BROWSER()) return browserBackend
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch('/api/library/health', { signal: ctrl.signal }).finally(() => clearTimeout(timer))
    const body = res.ok ? await res.json() : null
    if (!body?.ok) return browserBackend
    const disk = diskBackend(body.path)
    await migrateBrowserEntries(disk).catch((err) => console.warn('library: browser → disk copy failed', err))
    return disk
  } catch {
    return browserBackend
  }
}

/** One-time copy of IndexedDB entries into the disk database (newer wins). */
async function migrateBrowserEntries(disk: Backend): Promise<void> {
  const flag = `paperSim.libraryMigrated.${NS()}`
  if (pref(flag)) return
  if (typeof indexedDB === 'undefined') return
  const local = await browserBackend.listAll()
  if (local.length > 0) {
    const onDisk = new Map((await disk.listAll()).map((m) => [m.id, m]))
    for (const m of local) {
      const there = onDisk.get(m.id)
      if (there && there.updatedAt >= m.updatedAt) continue
      if (m.deletedAt) {
        if (there) await disk.tombstone(m.id, m.deletedAt)
        continue
      }
      const data = await browserBackend.getData(m.id)
      if (data) await disk.put(m, data)
    }
  }
  try {
    window.localStorage.setItem(flag, String(Date.now()))
  } catch {
    // Storage blocked: we'll just check again next time (copies are idempotent).
  }
}

// ---- public API --------------------------------------------------------------

/** Where the library is stored (for the gallery footer). */
export async function libraryLocation(): Promise<LibraryLocation> {
  return (await backend()).location
}

/** Every live entry's metadata, most recently updated first. */
export async function listLibrary(): Promise<LibraryMeta[]> {
  const all = await (await backend()).listAll()
  return all.filter((m) => !m.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Every entry including deletion tombstones (for sync). */
export async function listAllLibrary(): Promise<LibraryMeta[]> {
  return (await backend()).listAll()
}

export async function getLibraryMeta(id: string): Promise<LibraryMeta | undefined> {
  return (await backend()).getMeta(id)
}

export async function getLibraryData(id: string): Promise<LibraryData | undefined> {
  return (await backend()).getData(id)
}

/** Insert or replace an entry (timestamps are taken from `meta` as given). */
export async function putLibraryEntry(
  meta: LibraryMeta,
  data: LibraryData,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  await (await backend()).put(meta, data)
  notify(opts.quiet ? undefined : meta.id)
}

export async function renameLibraryEntry(id: string, name: string): Promise<void> {
  await (await backend()).rename(id, name, Date.now())
  notify(id)
}

/** Delete an entry (leaves a tombstone at `at`, default now). */
export async function deleteLibraryEntry(id: string, opts: { at?: number; quiet?: boolean } = {}): Promise<void> {
  await (await backend()).tombstone(id, opts.at ?? Date.now())
  notify(opts.quiet ? undefined : id)
}

export function newLibraryId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ---- change notifications ------------------------------------------------------
// Listeners get the id of a user-made change (so a cloud sync can push it), or
// undefined for "refresh only" (e.g. changes the sync itself pulled in).
const listeners = new Set<(changedId?: string) => void>()

export function onLibraryChange(fn: (changedId?: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyLibraryChange(changedId?: string) {
  notify(changedId)
}

function notify(changedId?: string) {
  for (const fn of listeners) fn(changedId)
}
