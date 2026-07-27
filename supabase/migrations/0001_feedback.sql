-- Malakai Stories — feedback table
-- Run this in the Supabase dashboard: SQL Editor → paste → Run.
-- (Project: yyvvbqggwkkncbistzzv)

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  rating      int,
  name        text,
  comment     text,
  language    text,
  url         text
);

-- Row Level Security: allow anyone to SUBMIT feedback, but nobody to READ it
-- from the browser. You read all feedback in the Supabase dashboard (Table
-- Editor / SQL), which uses the service role and bypasses RLS.
alter table public.feedback enable row level security;

drop policy if exists "anon can insert feedback" on public.feedback;
create policy "anon can insert feedback"
  on public.feedback
  for insert
  to anon
  with check (true);
