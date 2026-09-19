// Optional cloud sync for the project library. The local library (disk
// database, or IndexedDB fallback) stays the primary copy; when Supabase is
// configured (VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY in
// app/.env.local) and the user signs in, entries sync both ways.
//
// Merge rule, per entry id: the side with the newer stamp wins, where a stamp
// is deletedAt for a tombstone and updatedAt otherwise. Tombstones travel like
// edits, so a delete on one machine removes the entry everywhere.

import { create } from 'zustand'
import {
  deleteLibraryEntry,
  getLibraryData,
  listAllLibrary,
  notifyLibraryChange,
  onLibraryChange,
  putLibraryEntry,
  type LibraryData,
  type LibraryMeta,
} from './library'

/** A sync target (Supabase in the app; an in-memory fake in the verify script). */
export interface Remote {
  /** Every entry's metadata incl. tombstones; thumbnails may be omitted. */
  listAll(): Promise<LibraryMeta[]>
  /** One live entry, with its thumbnail. */
  get(id: string): Promise<{ meta: LibraryMeta; data: LibraryData } | undefined>
  put(meta: LibraryMeta, data: LibraryData): Promise<void>
  tombstone(id: string, at: number): Promise<void>
}

export interface SyncResult {
  pushed: number
  pulled: number
  deletedLocal: number
  deletedRemote: number
}

const stamp = (m: LibraryMeta) => m.deletedAt ?? m.updatedAt

/** One two-way pass between the local library and `remote`. */
export async function syncWith(remote: Remote): Promise<SyncResult> {
  const [local, far] = await Promise.all([listAllLibrary(), remote.listAll()])
  const L = new Map(local.map((m) => [m.id, m]))
  const R = new Map(far.map((m) => [m.id, m]))
  const out: SyncResult = { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0 }

  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id)
    const r = R.get(id)
    const localWins = l && (!r || stamp(l) > stamp(r))
    const remoteWins = r && (!l || stamp(r) > stamp(l))
    if (localWins) {
      if (l.deletedAt) {
        if (r && !r.deletedAt) {
          await remote.tombstone(id, l.deletedAt)
          out.deletedRemote++
        }
      } else {
        const data = await getLibraryData(id)
        if (data) {
          await remote.put(l, data)
          out.pushed++
        }
      }
    } else if (remoteWins) {
      if (r.deletedAt) {
        if (l && !l.deletedAt) {
          await deleteLibraryEntry(id, { at: r.deletedAt, quiet: true })
          out.deletedLocal++
        }
      } else {
        const got = await remote.get(id)
        if (got) {
          await putLibraryEntry(got.meta, got.data, { quiet: true })
          out.pulled++
        }
      }
    }
  }
  if (out.pulled || out.deletedLocal) notifyLibraryChange() // refresh the gallery only
  return out
}

// ---- status (drives the gallery footer) --------------------------------------
export interface CloudState {
  /** Supabase URL + key present in the build. */
  configured: boolean
  /** Signed-in email, or null. */
  email: string | null
  status: 'idle' | 'syncing' | 'error'
  lastSync: number | null
  lastResult: SyncResult | null
  error: string | null
  /** A sign-in link was sent to this address. */
  linkSentTo: string | null
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as
  | string
  | undefined

export const useCloud = create<CloudState>(() => ({
  configured: !!(SUPABASE_URL && SUPABASE_KEY),
  email: null,
  status: 'idle',
  lastSync: null,
  lastResult: null,
  error: null,
  linkSentTo: null,
}))

// ---- driver ------------------------------------------------------------------
type SupabaseModule = typeof import('./cloudSupabase')
let supa: Promise<SupabaseModule> | null = null
let activeRemote: Remote | null = null
let running: Promise<void> | null = null
let again = false

function loadSupabase(): Promise<SupabaseModule> {
  if (!supa) supa = import('./cloudSupabase') // code-split: only fetched when configured
  return supa
}

/** Run a sync now (coalesces: a request during a run schedules one more). */
export function syncNow(): Promise<void> {
  if (!activeRemote) return Promise.resolve()
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      useCloud.setState({ status: 'syncing', error: null })
      try {
        const lastResult = await syncWith(activeRemote!)
        useCloud.setState({ status: 'idle', lastSync: Date.now(), lastResult })
      } catch (err) {
        useCloud.setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        again = false
      }
    } while (again && activeRemote)
  })().finally(() => (running = null))
  return running
}

/**
 * Point sync at a remote (null = stop). Exposed for the verify script's fake
 * remote; the app calls it on Supabase sign-in / sign-out.
 */
export function setRemote(remote: Remote | null, email: string | null = null): void {
  activeRemote = remote
  useCloud.setState({ email, error: null, ...(remote ? {} : { lastSync: null, lastResult: null }) })
  if (remote) void syncNow()
}

let debounce: number | undefined
let started = false

/** App start: restore a Supabase session (and finish a magic-link sign-in). */
export function initCloudSync(): void {
  if (started) return
  started = true
  // Local edits sync shortly after they happen; returning to the tab pulls.
  onLibraryChange((changedId) => {
    if (!changedId || !activeRemote) return
    window.clearTimeout(debounce)
    debounce = window.setTimeout(() => void syncNow(), 1500)
  })
  let lastFocus = 0
  window.addEventListener('focus', () => {
    if (activeRemote && Date.now() - lastFocus > 60_000) {
      lastFocus = Date.now()
      void syncNow()
    }
  })
  if (!useCloud.getState().configured) return
  loadSupabase()
    .then((m) => m.startSupabase(SUPABASE_URL!, SUPABASE_KEY!))
    .catch((err) => useCloud.setState({ status: 'error', error: `cloud: ${err instanceof Error ? err.message : err}` }))
}

export async function sendSignInLink(email: string): Promise<void> {
  const m = await loadSupabase()
  await m.sendMagicLink(email)
  useCloud.setState({ linkSentTo: email })
}

export async function signOut(): Promise<void> {
  const m = await loadSupabase()
  await m.signOutSupabase()
}
