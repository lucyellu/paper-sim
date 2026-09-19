// File › Library… — a gallery of saved projects and imported dielines/photos
// (IndexedDB, see state/library.ts). Double-click a card to open it; rename
// and delete from the footer. Imports land here automatically.

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import {
  deleteLibraryEntry,
  libraryLocation,
  listLibrary,
  onLibraryChange,
  renameLibraryEntry,
  type LibraryKind,
  type LibraryLocation,
  type LibraryMeta,
} from '../state/library'
import { sendSignInLink, signOut, syncNow, useCloud } from '../state/cloudSync'
import { openLibraryEntry, saveToLibrary } from './libraryActions'

type Filter = 'all' | 'project' | 'import'

const KIND_LABEL: Record<LibraryKind, string> = {
  project: 'Project',
  dieline: 'Dieline import',
  photo: 'Photo import',
}

export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const currentId = useAppStore((s) => s.libraryId)
  const [entries, setEntries] = useState<LibraryMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(currentId)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [location, setLocation] = useState<LibraryLocation | null>(null)
  /** Escape cancels a rename; the input's unmount blur must not commit it. */
  const renameCancelled = useRef(false)

  useEffect(() => {
    let live = true
    const load = () =>
      listLibrary().then(
        (list) => live && setEntries(list),
        (err) => live && setError(`Couldn't read the library: ${err instanceof Error ? err.message : err}`),
      )
    void load()
    libraryLocation().then((l) => live && setLocation(l), () => {})
    const off = onLibraryChange(() => void load())
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !renaming) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, renaming])

  const q = query.trim().toLowerCase()
  const shown = (entries ?? []).filter(
    (e) =>
      (filter === 'all' || (filter === 'project' ? e.kind === 'project' : e.kind !== 'project')) &&
      (!q || e.name.toLowerCase().includes(q) || (e.sourceName ?? '').toLowerCase().includes(q)),
  )
  const pickedEntry = shown.find((e) => e.id === picked) ?? null

  async function run(fn: () => Promise<unknown>, fail: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(`${fail}: ${err instanceof Error ? err.message : err}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function open(id: string) {
    if (await run(() => openLibraryEntry(id), "Couldn't open it")) onClose()
  }

  async function remove(e: LibraryMeta) {
    if (!confirm(`Delete "${e.name}" from the library? This can't be undone.`)) return
    await run(async () => {
      await deleteLibraryEntry(e.id)
      if (useAppStore.getState().libraryId === e.id) useAppStore.getState().setLibraryId(null)
      setPicked(null)
    }, "Couldn't delete it")
  }

  function startRename(id: string) {
    renameCancelled.current = false
    setRenaming(id)
  }

  async function commitRename(e: LibraryMeta, name: string) {
    setRenaming(null)
    if (renameCancelled.current) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === e.name) return
    await run(async () => {
      await renameLibraryEntry(e.id, trimmed)
      // The open project follows its entry's name.
      if (useAppStore.getState().libraryId === e.id) useAppStore.getState().setProjectName(trimmed)
    }, "Couldn't rename it")
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal lib-modal" role="dialog" aria-label="Library">
        <div className="lib-head">
          <h2>Library</h2>
          <div className="seg lib-filter">
            {(['all', 'project', 'import'] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'project' ? 'Projects' : 'Imports'}
              </button>
            ))}
          </div>
          <input
            className="lib-search"
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {entries === null && !error && <p className="hint">Loading…</p>}
        {entries !== null && entries.length === 0 && (
          <p className="hint lib-empty">
            Nothing here yet. Use <b>Save current project</b> below (or Ctrl+S) to keep a project
            here. Imported dieline images and carton photos are added automatically.
          </p>
        )}
        {entries !== null && entries.length > 0 && shown.length === 0 && (
          <p className="hint lib-empty">No matches.</p>
        )}

        <div className="new-grid lib-grid">
          {shown.map((e) => (
            // A div, not a button: the rename field can't live inside a button.
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              className={`new-card lib-card ${picked === e.id ? 'picked' : ''}`}
              data-lib-id={e.id}
              title={e.sourceName ? `Imported from ${e.sourceName}` : e.name}
              onClick={() => setPicked(e.id)}
              onDoubleClick={() => renaming !== e.id && void open(e.id)}
              onKeyDown={(ev) => {
                if (ev.target !== ev.currentTarget) return
                if (ev.key === 'Enter') void open(e.id)
                else if (ev.key === 'F2') startRename(e.id)
                else if (ev.key === 'Delete') void remove(e)
              }}
            >
              {e.thumbnail ? <img src={e.thumbnail} alt="" draggable={false} /> : <div className="lib-nothumb" />}
              {currentId === e.id && <span className="lib-badge">Open</span>}
              {renaming === e.id ? (
                <input
                  className="lib-rename"
                  autoFocus
                  defaultValue={e.name}
                  onClick={(ev) => ev.stopPropagation()}
                  onDoubleClick={(ev) => ev.stopPropagation()}
                  onBlur={(ev) => void commitRename(e, ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                    if (ev.key === 'Escape') {
                      // Don't let the dialog's Escape-to-close see this one.
                      ev.stopPropagation()
                      renameCancelled.current = true
                      setRenaming(null)
                    }
                  }}
                />
              ) : (
                <span className="new-card-name">{e.name}</span>
              )}
              <span className="new-card-sub">
                {KIND_LABEL[e.kind]} · {formatWhen(e.updatedAt)}
              </span>
            </div>
          ))}
        </div>

        {error && <p className="hint photo-warn">{error}</p>}

        <div className="btn-row dlg-actions lib-actions">
          <button
            disabled={busy}
            title="Save the project you're working on into the library (Ctrl+S)"
            onClick={() =>
              void run(async () => setPicked(await saveToLibrary()), "Couldn't save it")
            }
          >
            Save current project
          </button>
          <span className="lib-spacer" />
          <button disabled={!pickedEntry || busy} onClick={() => pickedEntry && startRename(pickedEntry.id)}>
            Rename
          </button>
          <button disabled={!pickedEntry || busy} onClick={() => pickedEntry && void remove(pickedEntry)}>
            Delete
          </button>
          <button onClick={onClose}>Close</button>
          <button
            className="primary dlg-primary"
            disabled={!pickedEntry || busy}
            onClick={() => pickedEntry && void open(pickedEntry.id)}
          >
            Open
          </button>
        </div>
        <p className="hint lib-where" data-location={location?.kind}>
          Opening an entry replaces the current project.{' '}
          {location?.kind === 'disk' && (
            <>
              Saved on this computer in <code title={location.path}>{location.path}</code>.
            </>
          )}
          {location?.kind === 'browser' &&
            'The local library server isn’t running, so entries are kept in this browser only.'}
        </p>
        <CloudStatus />
      </div>
    </div>
  )
}

/** Cloud sync line: sign in by email link, sync status, sync now / sign out. */
function CloudStatus() {
  const c = useCloud()
  const [email, setEmail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  if (!c.email && !c.configured) {
    return (
      <p className="hint lib-cloud" data-cloud="off">
        Cloud sync is off. To sync between computers, add a Supabase project (see the app README).
      </p>
    )
  }
  if (!c.email) {
    return (
      <form
        className="lib-cloud lib-cloud-signin"
        data-cloud="signed-out"
        onSubmit={(e) => {
          e.preventDefault()
          if (!email.trim()) return
          setSending(true)
          setErr(null)
          sendSignInLink(email.trim())
            .catch((x) => setErr(x instanceof Error ? x.message : String(x)))
            .finally(() => setSending(false))
        }}
      >
        <span className="hint">Cloud sync: sign in to sync this library between computers.</span>
        <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" disabled={sending || !email.trim()}>
          Email me a sign-in link
        </button>
        {c.linkSentTo && !err && <span className="hint">Check {c.linkSentTo} for the link.</span>}
        {err && <span className="hint photo-warn">{err}</span>}
      </form>
    )
  }
  const r = c.lastResult
  const changes = r ? r.pushed + r.pulled + r.deletedLocal + r.deletedRemote : 0
  return (
    <div className="lib-cloud" data-cloud={c.status === 'error' ? 'error' : 'signed-in'}>
      <span className="hint">
        ☁ Syncing as <b>{c.email}</b> ·{' '}
        {c.status === 'syncing'
          ? 'syncing…'
          : c.status === 'error'
            ? <span className="photo-warn">sync failed: {c.error}</span>
            : c.lastSync
              ? `last synced ${formatWhen(c.lastSync)}${changes ? ` (${changes} change${changes === 1 ? '' : 's'})` : ''}`
              : 'not synced yet'}
      </span>
      <button disabled={c.status === 'syncing'} onClick={() => void syncNow()}>
        Sync now
      </button>
      <button onClick={() => void signOut().catch(() => {})}>Sign out</button>
    </div>
  )
}

function formatWhen(t: number): string {
  const d = new Date(t)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
