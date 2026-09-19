-- Paper Sim cloud library (optional sync target for the local library).
-- Run once in the Supabase SQL editor (or via a migration). Each signed-in
-- user sees only their own rows / files (RLS). Row = gallery metadata +
-- thumbnail; the project itself ({ file, fitSession } JSON, often several MB of
-- inline artwork) lives in the private `library` storage bucket at
-- <user id>/<entry id>.json. Entries in the app's trash keep their data and
-- have trashed_at set; permanent deletes are tombstones (deleted_at) so they sync.

create table if not exists public.library_entries (
  user_id     uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  id          text   not null,
  name        text   not null,
  kind        text   not null check (kind in ('project', 'dieline', 'photo')),
  created_at  bigint not null,  -- ms since epoch, as in the app
  updated_at  bigint not null,
  deleted_at  bigint,
  trashed_at  bigint,
  thumbnail   text,
  source_name text,
  primary key (user_id, id)
);
-- Tables created before the trash existed.
alter table public.library_entries add column if not exists trashed_at bigint;

alter table public.library_entries enable row level security;

create policy "own entries: select" on public.library_entries
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own entries: insert" on public.library_entries
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own entries: update" on public.library_entries
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own entries: delete" on public.library_entries
  for delete to authenticated using (user_id = (select auth.uid()));

-- Private bucket for the project payloads.
insert into storage.buckets (id, name, public)
values ('library', 'library', false)
on conflict (id) do nothing;

create policy "own library files: select" on storage.objects
  for select to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own library files: insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own library files: update" on storage.objects
  for update to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own library files: delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);
