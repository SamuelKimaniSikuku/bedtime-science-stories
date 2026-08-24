-- Malakai Stories · community translation platform
-- Dashboard → SQL Editor → New query → paste → Run.  Safe to re-run.
--
-- Turns translation into work anyone can do from a phone: a segment is one
-- paragraph, contributors propose, two other people approve, and
-- pull-translations.js exports what is approved into content/translations/<lang>.json.

-- ---------------------------------------------------------------- languages
-- One row per language we accept work in. Use ISO 639-3 for languages that have
-- no two-letter code: 'bxk' Lubukusu, 'rag' Maragoli, 'luo' Dholuo, 'kam' Kamba.
-- Never store the macro code 'luy' ("Luhya") as a translation target — the
-- varieties are not mutually intelligible and mixing them corrupts the corpus.
create table if not exists public.languages (
  code        text primary key,            -- 'bxk'
  macro       text,                        -- 'luy'  (grouping only, never a target)
  name_en     text not null,               -- 'Lubukusu'
  name_native text,                        -- 'Lubukusu'
  status      text not null default 'draft',  -- draft → open → live
  goal        int  not null default 10,    -- stories needed before it goes live on the site
  created_at  timestamptz not null default now()
);

insert into public.languages (code, macro, name_en, name_native, status) values
  ('sw',  null,  'Kiswahili', 'Kiswahili', 'live'),
  ('fr',  null,  'French',    'Français',  'live'),
  ('sv',  null,  'Swedish',   'Svenska',   'open'),
  ('ki',  null,  'Gikuyu',    'Gĩkũyũ',    'open'),
  ('bxk', 'luy', 'Lubukusu',  'Lubukusu',  'open'),
  ('rag', 'luy', 'Maragoli',  'Logooli',   'draft'),
  ('luo', null,  'Dholuo',    'Dholuo',    'draft')
on conflict (code) do nothing;

-- ----------------------------------------------------------------- segments
-- The English source, cut into the smallest reviewable unit. id is stable and
-- readable: '<story>:<field>:<index>', e.g. 'newton:text:2'.
create table if not exists public.segments (
  id        text primary key,
  story     text not null,
  field     text not null,               -- country | title | hook | text | textM | textL
  idx       int  not null default 0,     -- paragraph number within the field
  en        text not null,
  sw        text,                        -- pivot: most contributors read Kiswahili faster than English
  words     int,
  ord       int,                         -- global ordering, so tasks arrive in story order
  unique (story, field, idx)
);
create index if not exists segments_story on public.segments (story);

-- ------------------------------------------------------------- translations
create table if not exists public.translations (
  id           uuid primary key default gen_random_uuid(),
  segment_id   text not null references public.segments (id) on delete cascade,
  lang         text not null references public.languages (code),
  body         text,                     -- the translated text (null if audio-only for now)
  audio_path   text,                     -- storage path of a spoken recording
  author_name  text,
  author_contact text,                   -- optional: WhatsApp/email, for credit and follow-up
  license      text not null default 'CC-BY-4.0',
  status       text not null default 'proposed',   -- proposed → approved → published
  score        int  not null default 0,  -- maintained by the vote trigger below
  note         text,
  created_at   timestamptz not null default now(),
  constraint translations_has_content check (body is not null or audio_path is not null)
);
create index if not exists translations_seg_lang on public.translations (segment_id, lang, status);
create index if not exists translations_lang_status on public.translations (lang, status);

-- One approved translation per segment per language: the exporter must never
-- have to guess which of two winners to ship.
create unique index if not exists translations_one_approved
  on public.translations (segment_id, lang) where status in ('approved', 'published');

-- -------------------------------------------------------------------- votes
create table if not exists public.votes (
  translation_id uuid not null references public.translations (id) on delete cascade,
  voter          text not null,          -- contributor handle; one vote each
  score          int  not null check (score in (-1, 1)),
  created_at     timestamptz not null default now(),
  primary key (translation_id, voter)
);

create or replace function public.recount_votes() returns trigger
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  tid := coalesce(new.translation_id, old.translation_id);
  update public.translations t
     set score = coalesce((select sum(v.score) from public.votes v where v.translation_id = tid), 0)
   where t.id = tid;
  return null;
end $$;

drop trigger if exists votes_recount on public.votes;
create trigger votes_recount after insert or update or delete on public.votes
  for each row execute function public.recount_votes();

-- ------------------------------------------------------------------ the queue
-- What a contributor is served next: source segments with no proposal yet in
-- their language, in story order.
create or replace view public.open_segments as
  select l.code as lang, s.id, s.story, s.field, s.idx, s.en, s.sw, s.words, s.ord
    from public.segments s
   cross join public.languages l
   where l.status in ('open', 'live')
     and not exists (
       select 1 from public.translations t
        where t.segment_id = s.id and t.lang = l.code
     );

-- What needs a second pair of eyes.
create or replace view public.review_queue as
  select t.id, t.segment_id, t.lang, t.body, t.audio_path, t.author_name, t.score,
         s.story, s.field, s.idx, s.en, s.sw
    from public.translations t
    join public.segments s on s.id = t.segment_id
   where t.status = 'proposed'
   order by t.created_at;

-- Per-language progress, for the "help us finish Lubukusu" bar on the site.
create or replace view public.language_progress as
  select l.code, l.name_en, l.name_native, l.status, l.goal,
         count(t.id) filter (where t.status in ('approved','published')) as done,
         (select count(*) from public.segments)                          as total
    from public.languages l
    left join public.translations t on t.lang = l.code
   group by l.code, l.name_en, l.name_native, l.status, l.goal;

-- --------------------------------------------------------------------- RLS
-- Anyone may read the source and propose a translation; nothing else.
-- Approving, publishing and exporting all go through the service role.
alter table public.languages    enable row level security;
alter table public.segments     enable row level security;
alter table public.translations enable row level security;
alter table public.votes        enable row level security;

drop policy if exists languages_read on public.languages;
create policy languages_read on public.languages for select to anon, authenticated using (true);

drop policy if exists segments_read on public.segments;
create policy segments_read on public.segments for select to anon, authenticated using (true);

drop policy if exists translations_read on public.translations;
create policy translations_read on public.translations for select to anon, authenticated using (true);

-- A contribution can only ever arrive as 'proposed' with a zero score: a client
-- cannot self-approve by posting status='approved'.
drop policy if exists translations_propose on public.translations;
create policy translations_propose on public.translations for insert to anon, authenticated
  with check (
    status = 'proposed'
    and score = 0
    and length(coalesce(body, '')) <= 6000
    and exists (select 1 from public.languages l where l.code = lang and l.status in ('open','live'))
  );

drop policy if exists votes_read on public.votes;
create policy votes_read on public.votes for select to anon, authenticated using (true);

drop policy if exists votes_cast on public.votes;
create policy votes_cast on public.votes for insert to anon, authenticated with check (true);

-- Contributors never update or delete: no update/delete policy exists, so those
-- are denied for anon by default. Corrections are a new proposal.
