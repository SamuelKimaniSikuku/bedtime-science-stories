-- Atomic, service-only allowances and private feedback tokens for Ask why.
-- Existing rows are left intact. New requests do not store the raw IP address.
begin;

alter table public.ask_log alter column ip drop not null;
alter table public.ask_log add column if not exists subject_key text;
alter table public.ask_log add column if not exists rating_token uuid default gen_random_uuid();
alter table public.ask_log add column if not exists status text not null default 'legacy';
create index if not exists ask_log_subject_time on public.ask_log (subject_key, created_at);

create or replace function public.reserve_ask(
  p_subject_key text, p_user_id uuid, p_story text, p_lang text, p_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  used integer;
  oldest timestamptz;
  checked_at timestamptz;
  wait_seconds integer;
  entry_id bigint;
  feedback_token uuid;
begin
  if p_subject_key is null or p_subject_key !~ '^[ug]:[0-9a-f]{64}$'
     or p_limit is null or p_limit < 1 or p_limit > 100
     or p_story is null or p_story !~ '^[a-z0-9-]{1,40}$'
     or p_lang is null or p_lang not in ('en', 'sw', 'fr')
     or (p_user_id is null and left(p_subject_key, 2) <> 'g:')
     or (p_user_id is not null and left(p_subject_key, 2) <> 'u:') then
    raise exception 'Invalid reservation';
  end if;

  -- All requests for one subject serialize before counting or inserting.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_subject_key, 0));
  checked_at := clock_timestamp();
  select count(*)::integer, min(created_at) into used, oldest
    from public.ask_log
    where subject_key = p_subject_key and created_at > checked_at - interval '24 hours';
  wait_seconds := case when oldest is null then 86400
    else greatest(1, ceil(extract(epoch from oldest + interval '24 hours' - checked_at))::integer) end;
  if used >= p_limit then
    -- If an operator reduced the limit, enough older reservations must expire
    -- to bring the subject below the new limit, not merely the oldest one.
    select created_at into oldest from public.ask_log
      where subject_key = p_subject_key and created_at > checked_at - interval '24 hours'
      order by created_at offset (used - p_limit) limit 1;
    wait_seconds := greatest(1, ceil(extract(epoch from oldest + interval '24 hours' - checked_at))::integer);
    return jsonb_build_object('allowed', false, 'remaining', 0, 'retry_after', wait_seconds);
  end if;

  insert into public.ask_log (user_id, subject_key, story, lang, suitable, status, created_at)
    values (p_user_id, p_subject_key, p_story, p_lang, false, 'pending', checked_at)
    returning id, rating_token into entry_id, feedback_token;
  return jsonb_build_object('allowed', true, 'id', entry_id, 'rating_token', feedback_token,
    'remaining', p_limit - used - 1, 'retry_after', wait_seconds);
end;
$$;

-- An API caller cannot choose its own identity or allowance, even with a JWT.
revoke all on function public.reserve_ask(text, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_ask(text, uuid, text, text, integer) to service_role;
revoke all on public.ask_log from anon, authenticated;

commit;
