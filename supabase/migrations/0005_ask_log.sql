-- Malakai Stories — "Ask why" nightly limit + answer ratings
-- Dashboard → SQL Editor → paste → Run.  Safe to re-run.
--
-- One row per answered question, used only to count questions per visitor per
-- day and to keep the parent's thumbs up / down. The question text itself is
-- deliberately NOT stored anywhere.

create table if not exists public.ask_log (
  id          bigint generated always as identity primary key,
  ip          text not null,
  user_id     uuid references auth.users (id) on delete set null,
  story       text,
  lang        text,
  suitable    boolean not null default true,   -- false = the model declined and left a note for the parent
  rating      smallint,                        -- 1 = good answer, -1 = not quite, null = not rated
  created_at  timestamptz not null default now()
);
create index if not exists ask_log_ip_time   on public.ask_log (ip, created_at);
create index if not exists ask_log_user_time on public.ask_log (user_id, created_at);

-- Only the service role (the edge function) can read or write it.
alter table public.ask_log enable row level security;
