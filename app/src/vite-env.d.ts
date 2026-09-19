/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional cloud library (app/.env.local): Supabase project URL… */
  readonly VITE_SUPABASE_URL?: string
  /** …and its publishable (or legacy anon) key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}
