-- Malakai Stories — family accounts (magic-link sign-in, cross-device sync)
-- Dashboard → SQL Editor → paste → Run.  Safe to re-run.
--
-- One row per signed-in family. The site works fully without an account
-- (everything lives in localStorage); signing in simply syncs that same state
-- across devices. Auth itself is Supabase's built-in magic-link email flow —
-- no passwords are ever stored.
--
-- ALSO REQUIRED, in the dashboard (not SQL):
--   Authentication → URL Configuration → Site URL = https://malakaistory.com
--   (otherwise the magic-link emails redirect to localhost)

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  read_map    jsonb not null default '{}'::jsonb,   -- storyId -> first-read timestamp (ms)
  favorites   jsonb not null default '[]'::jsonb,   -- array of favourite story ids
  fav_tracks  jsonb not null default '[]'::jsonb,   -- array of favourite lullaby files
  prefs       jsonb not null default '{}'::jsonb,   -- { lang, narrator, storyLen, track }
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A family can only ever see and edit its own row.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
