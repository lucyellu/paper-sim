// Supabase side of the cloud library (loaded on demand by cloudSync.ts only
// when VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are set). Schema and
// RLS: app/supabase/library.sql. Sign-in is a passwordless email link that
// returns to this page.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { setRemote, type Remote } from './cloudSync'
import type { LibraryData, LibraryKind, LibraryMeta } from './library'

const TABLE = 'library_entries'
const BUCKET = 'library'
const META_COLS = 'id, name, kind, created_at, updated_at, deleted_at, source_name'

let client: SupabaseClient | null = null

interface Row {
  id: string
  name: string
  kind: LibraryKind
  created_at: number
  updated_at: number
  deleted_at: number | null
  thumbnail?: string | null
  source_name: string | null
}

function metaOf(r: Row): LibraryMeta {
  const m: LibraryMeta = {
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
  if (r.thumbnail) m.thumbnail = r.thumbnail
  if (r.source_name) m.sourceName = r.source_name
  if (r.deleted_at) m.deletedAt = Number(r.deleted_at)
  return m
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

function supabaseRemote(sb: SupabaseClient, userId: string): Remote {
  const path = (id: string) => `${userId}/${encodeURIComponent(id)}.json`
  return {
    async listAll() {
      const rows = check(await sb.from(TABLE).select(META_COLS)) as Row[]
      return rows.map(metaOf)
    },
    async get(id) {
      const row = check(await sb.from(TABLE).select(`${META_COLS}, thumbnail`).eq('id', id).maybeSingle()) as Row | null
      if (!row || row.deleted_at) return undefined
      const blob = check(await sb.storage.from(BUCKET).download(path(id)))
      if (!blob) throw new Error(`cloud copy of "${row.name}" has no project file`)
      const payload = JSON.parse(await blob.text())
      return { meta: metaOf(row), data: { id, file: payload.file, fitSession: payload.fitSession ?? undefined } }
    },
    async put(meta, data: LibraryData) {
      // Payload first: a row never points at a missing file.
      const body = JSON.stringify({ file: data.file, fitSession: data.fitSession ?? null })
      check(
        await sb.storage
          .from(BUCKET)
          .upload(path(meta.id), new Blob([body], { type: 'application/json' }), { upsert: true }),
      )
      check(
        await sb.from(TABLE).upsert({
          user_id: userId,
          id: meta.id,
          name: meta.name,
          kind: meta.kind,
          created_at: meta.createdAt,
          updated_at: meta.updatedAt,
          deleted_at: null,
          thumbnail: meta.thumbnail ?? null,
          source_name: meta.sourceName ?? null,
        }),
      )
    },
    async tombstone(id, at) {
      check(
        await sb
          .from(TABLE)
          .update({ deleted_at: at, updated_at: at, thumbnail: null })
          .eq('id', id),
      )
      // Best effort: a leftover payload is harmless (the row says deleted).
      await sb.storage.from(BUCKET).remove([path(id)])
    },
  }
}

export async function startSupabase(url: string, key: string): Promise<void> {
  if (client) return
  client = createClient(url, key, { auth: { persistSession: true, detectSessionInUrl: true } })
  const sb = client
  let userId: string | null = null
  sb.auth.onAuthStateChange((_event, session) => {
    // Token refreshes fire this too: only act when the signed-in user changes.
    const next = session?.user?.id ?? null
    if (next === userId) return
    userId = next
    // Defer: the auth callback must not await Supabase calls itself.
    setTimeout(() => {
      if (session?.user) setRemote(supabaseRemote(sb, session.user.id), session.user.email ?? session.user.id)
      else setRemote(null)
    }, 0)
  })
  await sb.auth.getSession() // triggers INITIAL_SESSION (and consumes a magic-link return)
}

export async function sendMagicLink(email: string): Promise<void> {
  if (!client) throw new Error('cloud sync is not configured')
  const redirect = window.location.origin + window.location.pathname
  check(await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } }))
}

export async function signOutSupabase(): Promise<void> {
  if (!client) return
  const { error } = await client.auth.signOut()
  if (error) throw new Error(error.message)
}
