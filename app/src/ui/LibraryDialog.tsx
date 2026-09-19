// File › Library… — a gallery of saved projects and imported dielines/photos
// (see state/library.ts). Double-click a card to open it; rename and delete
// from the footer. Delete moves an entry to the Trash tab, where it can be
// restored or deleted for good. Imports land here automatically.

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import {
  deleteLibraryEntry,
  emptyTrash,
  libraryLocation,
  listLibrary,
  listTrash,
  onLibraryChange,
  purgeExpiredTrash,
  renameLibraryEntry,
  restoreLibraryEntry,
  trashLibraryEntry,
  TRASH_DAYS,
  type LibraryKind,
  type LibraryLocation,
  type LibraryMeta,
} from '../state/library'
import { sendSignInLink, signOut, syncNow, useCloud } from '../state/cloudSync'
import { openLibraryEntry, saveToLibrary } from './libraryActions'

type Filter = 'all' | 'project' | 'import' | 'trash'

const KIND_LABEL: Record<LibraryKind, string> = {
  project: 'Project',
  dieline: 'Dieline import',
  photo: 'Photo import',
}

export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const currentId = useAppStore((s) => s.libraryId)
  const [entries, setEntries] = useState<LibraryMeta[] | null>(null)
  const [trash, setTrash] = useState<LibraryMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(currentId)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [location, setLocation] = useState<LibraryLocation | null>(null)
  /** The entry just moved to the trash, offered back via Undo. */
  const [undo, setUndo] = useState<{ entry: LibraryMeta; wasOpen: boolean } | null>(null)
  /** Escape cancels a rename; the input's unmount blur must not commit it. */
  const renameCancelled = useRef(false)

  useEffect(() => {
    let live = true
    const load = () =>
      Promise.all([listLibrary(), listTrash()]).then(
        ([list, trashed]) => {
          if (!live) return
          setEntries(list)
          setTrash(trashed)
        },
        (err) => live && setError(`Couldn't read the library: ${err instanceof Error ? err.message : err}`),
      )
    // Expired trash goes first so it never flashes up in the Trash tab.
    void purgeExpiredTrash()
      .catch((err) => console.warn('library: trash purge failed', err))
      .then(load)
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

  const inTrash = filter === 'trash'
  const q = query.trim().toLowerCase()
  const shown = (inTrash ? trash : (entries ?? [])).filter(
    (e) =>
      (filter === 'all' || inTrash || (filter === 'project' ? e.kind === 'project' : e.kind !== 'project')) &&
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

  /** Move to the trash (no confirm: it can be undone). */
  async function remove(e: LibraryMeta) {
    await run(async () => {
      await trashLibraryEntry(e.id)
      const wasOpen = useAppStore.getState().libraryId === e.id
      // Unlink the open project, so Ctrl+S makes a new entry rather than quietly
      // pulling this one back out of the trash.
      if (wasOpen) useAppStore.getState().setLibraryId(null)
      setPicked(null)
      setUndo({ entry: e, wasOpen })
    }, "Couldn't delete it")
  }

  async function restore(e: LibraryMeta, relink = false) {
    await run(async () => {
      await restoreLibraryEntry(e.id)
      if (relink && useAppStore.getState().libraryId === null) useAppStore.getState().setLibraryId(e.id)
      setUndo(null)
      setPicked(e.id)
    }, "Couldn't restore it")
  }

  async function deleteForever(e: LibraryMeta) {
    if (!confirm(`Permanently delete "${e.name}"? This can't be undone.`)) return
    await run(async () => {
      await deleteLibraryEntry(e.id)
      setPicked(null)
      if (undo?.entry.id === e.id) setUndo(null)
    }, "Couldn't delete it")
  }

  async function empty() {
    const n = trash.length
    if (!confirm(`Permanently delete ${n === 1 ? 'the 1 item' : `all ${n} items`} in the trash? This can't be undone.`)) return
    await run(async () => {
      await emptyTrash()
      setPicked(null)
      setUndo(null)
    }, "Couldn't empty the trash")
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
            {(['all', 'project', 'import', 'trash'] as Filter[]).map((f) => (
              <button
                key={f}
                className={`${filter === f ? 'active' : ''} ${f === 'trash' ? 'lib-trash-tab' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'project' ? 'Projects' : f === 'import' ? 'Imports' : 'Trash'}
                {f === 'trash' && trash.length > 0 && <span className="lib-count">{trash.length}</span>}
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
        {inTrash && entries !== null && (
          <p className="hint lib-trash-note">
            {trash.length === 0
              ? 'The trash is empty.'
              : `Deleted entries stay here for ${TRASH_DAYS} days, then they're gone for good.`}
          </p>
        )}
        {!inTrash && entries !== null && entries.length === 0 && (
          <p className="hint lib-empty">
            Nothing here yet. Use <b>Save current project</b> below (or Ctrl+S) to keep a project
            here. Imported dieline images and carton photos are added automatically.
          </p>
        )}
        {entries !== null && (inTrash ? trash : entries).length > 0 && shown.length === 0 && (
          <p className="hint lib-empty">No matches.</p>
        )}

        <div className="new-grid lib-grid">
          {shown.map((e) => (
            // A div, not a button: the rename field can't live inside a button.
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              className={`new-card lib-card ${picked === e.id ? 'picked' : ''} ${inTrash ? 'trashed' : ''}`}
              data-lib-id={e.id}
              title={e.sourceName ? `Imported from ${e.sourceName}` : e.name}
              onClick={() => setPicked(e.id)}
              onDoubleClick={() => !inTrash && renaming !== e.id && void open(e.id)}
              onKeyDown={(ev) => {
                if (ev.target !== ev.currentTarget) return
                if (inTrash) {
                  if (ev.key === 'Enter') void restore(e)
                  else if (ev.key === 'Delete') void deleteForever(e)
                } else if (ev.key === 'Enter') void open(e.id)
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
                {KIND_LABEL[e.kind]} ·{' '}
                {inTrash && e.trashedAt ? `deleted ${formatWhen(e.trashedAt)}` : formatWhen(e.updatedAt)}
              </span>
            </div>
          ))}
        </div>

        {error && <p className="hint photo-warn">{error}</p>}
        {undo && !error && (
          <p className="hint lib-undo">
            Moved “{undo.entry.name}” to the trash.{' '}
            <button className="lib-link" disabled={busy} onClick={() => void restore(undo.entry, undo.wasOpen)}>
              Undo
            </button>
          </p>
        )}

        {inTrash ? (
          <div className="btn-row dlg-actions lib-actions">
            <button disabled={trash.length === 0 || busy} onClick={() => void empty()}>
              Empty trash
            </button>
            <span className="lib-spacer" />
            <button disabled={!pickedEntry || busy} onClick={() => pickedEntry && void deleteForever(pickedEntry)}>
              Delete forever
            </button>
            <button onClick={onClose}>Close</button>
            <button
              className="primary dlg-primary"
              disabled={!pickedEntry || busy}
              onClick={() => pickedEntry && void restore(pickedEntry)}
            >
              Restore
            </button>
          </div>
        ) : (
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
            <button
              disabled={!pickedEntry || busy}
              title="Move to the trash (Delete key); restore it from the Trash tab"
              onClick={() => pickedEntry && void remove(pickedEntry)}
            >
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
        )}
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
