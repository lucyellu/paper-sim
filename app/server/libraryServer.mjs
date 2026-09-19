// Local library database: a SQLite file on disk (node:sqlite, no native deps)
// served as a small JSON API under /api/library by the Vite dev/preview
// server — so `npm run dev` (and the desktop launcher) bring it up for free.
//
//   GET    /api/library/health      -> { ok, path }
//   GET    /api/library[?all=1]     -> LibraryMeta[] (all=1 includes deleted tombstones, for sync)
//   GET    /api/library/:id         -> { meta, data }, or null if there's no such live entry
//                                      (200, not 404: "not saved yet" is routine and a 404
//                                      would log a console error in the browser)
//   PUT    /api/library/:id         <- { meta, data }  (upsert; clears a tombstone)
//   PATCH  /api/library/:id         <- { name, updatedAt? }
//   DELETE /api/library/:id[?at=ms] -> tombstone (kept so a cloud sync can propagate it)
//   DELETE /api/library             -> purge a whole namespace (never "default"; test cleanup)
//
// Entries are partitioned by the `x-papersim-ns` header (default "default") so
// the verify scripts can work in a throwaway namespace without touching the
// real library. The database lives in <repo>/library/library.db unless
// PAPERSIM_LIBRARY_DIR says otherwise.

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = resolve(HERE, '..', '..', 'library')
const MAX_BODY = 200 * 1024 * 1024
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

let db = null
let dbPath = ''

async function openDb() {
  if (db) return db
  // Imported lazily: node:sqlite prints an ExperimentalWarning on load.
  const { DatabaseSync } = await import('node:sqlite')
  const dir = process.env.PAPERSIM_LIBRARY_DIR ? resolve(process.env.PAPERSIM_LIBRARY_DIR) : DEFAULT_DIR
  mkdirSync(dir, { recursive: true })
  dbPath = join(dir, 'library.db')
  db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS entries (
      ns          TEXT    NOT NULL,
      id          TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER,
      thumbnail   TEXT,
      source_name TEXT,
      data        TEXT,
      PRIMARY KEY (ns, id)
    );
  `)
  return db
}

function metaOf(row) {
  const m = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.thumbnail) m.thumbnail = row.thumbnail
  if (row.source_name) m.sourceName = row.source_name
  if (row.deleted_at) m.deletedAt = row.deleted_at
  return m
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('entry too large'), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('bad JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Only the app itself may use the API: the Host must be local (blocks DNS
 * rebinding) and a cross-origin page may not read or write (Origin check).
 */
function allowed(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!LOCAL_HOSTS.has(host)) return false
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false
    } catch {
      return false
    }
  }
  return true
}

const num = (v) => (Number.isFinite(v) ? Math.round(v) : null)
const str = (v) => (typeof v === 'string' ? v : null)
const KINDS = new Set(['project', 'dieline', 'photo'])

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const rest = url.pathname.replace(/^\/api\/library\/?/, '')
  const id = rest ? decodeURIComponent(rest) : ''
  const ns = str(req.headers['x-papersim-ns'])?.slice(0, 64) || 'default'
  const d = await openDb()

  if (id === 'health' && req.method === 'GET') return send(res, 200, { ok: true, path: dbPath })

  if (!id) {
    if (req.method === 'DELETE') {
      if (ns === 'default') return send(res, 403, { error: 'refusing to purge the default library' })
      d.prepare('DELETE FROM entries WHERE ns = ?').run(ns)
      return send(res, 204)
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
    const all = url.searchParams.get('all') === '1'
    const rows = d
      .prepare(
        `SELECT id, name, kind, created_at, updated_at, deleted_at, thumbnail, source_name
           FROM entries WHERE ns = ? ${all ? '' : 'AND deleted_at IS NULL'}
          ORDER BY updated_at DESC`,
      )
      .all(ns)
    return send(res, 200, rows.map(metaOf))
  }

  switch (req.method) {
    case 'GET': {
      const row = d.prepare('SELECT * FROM entries WHERE ns = ? AND id = ? AND deleted_at IS NULL').get(ns, id)
      if (!row) return send(res, 200, null)
      return send(res, 200, { meta: metaOf(row), data: { id, ...JSON.parse(row.data ?? '{}') } })
    }
    case 'PUT': {
      const { meta, data } = await readJson(req)
      if (!meta || meta.id !== id || !data || typeof data.file !== 'object') {
        return send(res, 400, { error: 'expected { meta, data } for this id' })
      }
      const now = Date.now()
      d.prepare(
        `INSERT INTO entries (ns, id, name, kind, created_at, updated_at, deleted_at, thumbnail, source_name, data)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (ns, id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = NULL, thumbnail = excluded.thumbnail,
           source_name = excluded.source_name, data = excluded.data`,
      ).run(
        ns,
        id,
        str(meta.name) ?? 'untitled',
        KINDS.has(meta.kind) ? meta.kind : 'project',
        num(meta.createdAt) ?? now,
        num(meta.updatedAt) ?? now,
        str(meta.thumbnail),
        str(meta.sourceName),
        JSON.stringify({ file: data.file, fitSession: data.fitSession ?? null }),
      )
      return send(res, 204)
    }
    case 'PATCH': {
      const body = await readJson(req)
      const name = str(body.name)?.trim()
      if (!name) return send(res, 400, { error: 'expected { name }' })
      const r = d
        .prepare('UPDATE entries SET name = ?, updated_at = ? WHERE ns = ? AND id = ? AND deleted_at IS NULL')
        .run(name, num(body.updatedAt) ?? Date.now(), ns, id)
      return send(res, r.changes ? 204 : 404, r.changes ? undefined : { error: 'not found' })
    }
    case 'DELETE': {
      const atParam = url.searchParams.get('at')
      const at = (atParam !== null ? num(Number(atParam)) : null) ?? Date.now()
      // Tombstone: drop the payload, keep the id + time so a sync can pass the delete on.
      d.prepare(
        `INSERT INTO entries (ns, id, name, kind, created_at, updated_at, deleted_at)
         VALUES (?, ?, '', 'project', ?, ?, ?)
         ON CONFLICT (ns, id) DO UPDATE SET
           deleted_at = excluded.deleted_at, updated_at = excluded.updated_at,
           data = NULL, thumbnail = NULL`,
      ).run(ns, id, at, at, at)
      return send(res, 204)
    }
    default:
      return send(res, 405, { error: 'method not allowed' })
  }
}

function middleware(req, res, next) {
  if (!req.url?.startsWith('/api/library')) return next()
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' })
  handle(req, res).catch((err) => {
    console.error('[library]', err)
    if (!res.headersSent) send(res, err.status ?? 500, { error: String(err.message ?? err) })
  })
}

/** Vite plugin: mounts the library API on the dev and preview servers. */
export function libraryServer() {
  return {
    name: 'paper-sim-library',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
