-- Malakai Stories — the family memory book
-- Dashboard → SQL Editor → paste → Run.  Safe to re-run.
--
-- After a story, a signed-in parent can leave a few words and/or a short voice
-- note "for when the child is older". Rows and recordings are private to the
-- family that made them: RLS on the table, and a private storage bucket whose
-- policies only let a user touch files inside their own folder ({user id}/…).

create table if not exists public.memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  story       text,                       -- story id the note belongs to
  night       date not null,              -- the night the story was read
  note        text,                       -- the parent's words (may be empty if only a recording)
  audio_path  text,                       -- storage path in the "memories" bucket, or null
  audio_secs  int,
  created_at  timestamptz not null default now()
);
create index if not exists memories_user_night on public.memories (user_id, night desc);

alter table public.memories enable row level security;

drop policy if exists memories_select on public.memories;
create policy memories_select on public.memories
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists memories_insert on public.memories;
create policy memories_insert on public.memories
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists memories_delete on public.memories;
create policy memories_delete on public.memories
  for delete to authenticated using (auth.uid() = user_id);

-- Private bucket for the voice notes. 10 MB is plenty for a 60-second clip.
insert into storage.buckets (id, name, public, file_size_limit)
values ('memories', 'memories', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

-- A family may only read, add, or remove files inside its own folder.
drop policy if exists memories_files_select on storage.objects;
create policy memories_files_select on storage.objects
  for select to authenticated
  using (bucket_id = 'memories' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists memories_files_insert on storage.objects;
create policy memories_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'memories' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists memories_files_delete on storage.objects;
create policy memories_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'memories' and (storage.foldername(name))[1] = auth.uid()::text);
