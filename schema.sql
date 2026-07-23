-- Malakai Stories · voice-pack orders
-- Run this once in Supabase Dashboard → SQL Editor → New query → paste → Run

create table if not exists public.orders (
  id          uuid primary key default gen_random_uuid(),
  token       text unique not null,
  parent_name text not null,
  child_name  text,
  email       text not null,
  package     text not null default 'one',
  langs       text[] not null default '{en}',
  status      text not null default 'new',   -- new → paid → generating → done
  voice_id    text,
  sample_path text,
  done_keys   text[] not null default '{}',
  error       text,
  created_at  timestamptz not null default now()
);

-- Lock the table down: only the service role (used by the edge functions) can touch it.
alter table public.orders enable row level security;

-- Rate-limiting log for the public "narrate" function. One row is written per NEW
-- (uncached) Sarah/William generation, so we can cap how many a single visitor can
-- trigger per day. Cached replays are never logged and stay unlimited/free.
create table if not exists public.narrate_log (
  id         bigint generated always as identity primary key,
  ip         text not null,
  story      text,
  lang       text,
  voice      text,
  created_at timestamptz not null default now()
);
create index if not exists narrate_log_ip_time on public.narrate_log (ip, created_at);

-- Only the service role (the edge function) can read/write it.
alter table public.narrate_log enable row level security;

-- Storage buckets: private samples, public voice packs
insert into storage.buckets (id, name, public)
values ('samples', 'samples', false), ('voicepacks', 'voicepacks', true)
on conflict (id) do nothing;
