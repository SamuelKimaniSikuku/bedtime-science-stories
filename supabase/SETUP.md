# Supabase setup — Malakai Stories voice packs

One-time setup, all in the Supabase Dashboard (about 10 minutes). No command line needed.

## 1 · Database & storage

Dashboard → **SQL Editor** → *New query* → paste the whole contents of `schema.sql` → **Run**.
This creates the `orders` table, the `narrate_log` table (used to rate-limit free trials),
and two storage buckets (`samples` private, `voicepacks` public).

> Already ran an older `schema.sql`? Just re-run it — it only *adds* `narrate_log`
> (everything uses `create ... if not exists`, so nothing existing is touched).

## 2 · Edge functions

Dashboard → **Edge Functions** → *Deploy a new function* (via Editor):

1. Name it exactly `submit-order`, paste the contents of `functions/submit-order/index.ts`, deploy.
2. Repeat with `process-order` and `functions/process-order/index.ts`.
3. Also deploy `narrate` from `functions/narrate/index.ts` (the public read-aloud voices).
4. For **all three** functions: open the function → **Details** → turn **Enforce JWT verification OFF**.
   (submit-order and narrate are meant to be public; process-order protects itself with your admin key.)

### Free-trial limits (the `narrate` function)

The public read-aloud feature is bounded so visitors can't run up your ElevenLabs bill:

- **One trial voice (Sarah).** William is commented out in `functions/narrate/index.ts` and
  removed from `HOUSE_VOICES` in `index.html`. Uncomment both to bring William back.
- **No 10-minute length in the trial.** Only 2-min and 5-min can be generated (`ALLOWED_LENGTHS`
  in the narrate function; `lengthsFor` in `index.html`).
- **3 new narrations per visitor per day.** Each *first-time* (uncached) generation is logged to
  `narrate_log` by IP; the 4th within 24h gets a friendly "come back tomorrow" message. Replaying
  a story that's already been made is free and never counted. Change the cap via `DAILY_LIMIT`
  at the top of `functions/narrate/index.ts`, then redeploy.

## 3 · Secrets

Dashboard → **Edge Functions** → **Secrets** → add:

| Name | Value |
|---|---|
| `ELEVENLABS_API_KEY` | your ElevenLabs API key (scopes: Voices read & write, Text to Speech; User read optional) |
| `ADMIN_KEY` | a long password you invent (e.g. from a password generator). You'll type this same value into admin.html. |

## 4 · Connect the website

Tell Claude (or edit by hand) your **project URL** — Dashboard → Settings → API → *Project URL*,
it looks like `https://abcdefgh.supabase.co`. It goes into one constant near the top of the
script in each of these files:

- `index.html` → `VOICEPACK_BASE = "https://YOUR-PROJECT.supabase.co/storage/v1/object/public/voicepacks"`
- `your-voice.html` → `SUPABASE_FN_BASE = "https://YOUR-PROJECT.supabase.co/functions/v1"`
- `admin.html` → pre-filled default for the same functions URL (optional; can also be typed on the page)

The project URL is public information — it is safe to have in the website code.
The service-role key and ElevenLabs key are **never** in the website; they live only in Supabase.

## 5 · Daily workflow

1. Customer records on `your-voice.html` → order appears in `admin.html` with status **new**.
2. You confirm payment with them (M-Pesa/card) → click **Mark paid**.
3. Click **Generate** → the page clones their voice and generates every story (a progress bar runs;
   keep the tab open — it calls the backend in small batches until done).
4. Click **Copy link** → send the customer `https://malakaistory.com/?voice=THEIRTOKEN`.
   On that link, "Read to me" plays their own voice.
5. Optionally click **Free voice slot** afterwards — ElevenLabs plans limit concurrent clones;
   the sample stays stored, so you can re-clone later if needed.

## Notes

- Story texts are read from `https://malakaistory.com/stories.json`. When new stories are added
  to the site, that file is regenerated too, and you can re-run **Generate** on an old order
  to top it up with the new stories (existing files are kept, only missing ones are made).
- Costs: one language ≈ 50k ElevenLabs credits per customer; all three ≈ 153k.

## 6 · Community translation queue

Adding a language (Lubukusu, Dholuo, …) no longer means editing `index.html`. Content now lives in
`content/` and the site is assembled from it.

```
content/source.json               metadata + English text (the source of truth)
content/translations/<lang>.json  one file per language
       ↓  node build-stories-json.js
index.html + stories.json         generated — never hand-edit the STORIES array
```

**One-time setup.** Dashboard → **SQL Editor** → paste `migrations/0003_translations.sql` → **Run**.
It creates `languages`, `segments` (the English source cut into ~1,900 paragraph-sized tasks),
`translations`, `votes`, and the `open_segments` / `review_queue` / `language_progress` views.
RLS lets anyone read and propose; only the service role approves or publishes.

Then load the source into the queue (the key is read from your shell, never stored in the repo):

```
node seed-translations.js                                    # dry run: shows the counts
SUPABASE_URL=https://yyvvbqggwkkncbistzzv.supabase.co \
SUPABASE_SERVICE_KEY=... node seed-translations.js --push
```

**Round trip, once translations come in.**

```
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node pull-translations.js   # approved rows → content/
node build-stories-json.js                                           # content/ → site
git commit -am "Lubukusu: first 10 stories" && git push              # deploys
```

`node build-stories-json.js --check` verifies the built site matches `content/` and writes nothing —
useful before committing.

**Adding a language.** Insert a row in `languages` with its ISO 639-3 code and `status='open'`.
Use the specific variety, never the macro code: `bxk` Lubukusu, `rag` Maragoli — "Luhya" (`luy`)
is a group of varieties that are not mutually intelligible, and mixing them corrupts the corpus.
A language shows on the site once its `goal` (default 10 stories) is approved.

## 7 · Family accounts (magic-link sign-in, cross-device sync)

The site works fully with no account — reading progress, favourites, language and music choices
all live in the browser's `localStorage`. Signing in just syncs that same state to a `profiles`
row so it follows the family across phone, tablet, etc. There are no passwords anywhere.

**One-time setup.**

1. Dashboard → **SQL Editor** → paste `migrations/0004_profiles.sql` → **Run**. Creates the
   `profiles` table (`read_map`, `favorites`, `fav_tracks`, `prefs` — one row per signed-in family)
   with RLS so a family can only ever read or write its own row.
2. Dashboard → **Authentication** → **Providers** → confirm **Email** is enabled (it is by default
   on a new project). Nothing else needs configuring here — the site never asks for a password.
3. Dashboard → **Authentication** → **URL Configuration**:
   - **Site URL** → `https://malakaistory.com`
   - **Redirect URLs** → add `https://malakaistory.com/*`
   (Skipping this step is the one thing that actually breaks sign-in: without it, the magic-link
   email sends people to `localhost` instead of back to the live site.)

That's it — no edge function, no secret key. The browser calls Supabase Auth's REST API directly
with the same public anon key already in `index.html` (`SUPABASE_ANON_KEY`); every request after
sign-in carries the visitor's own session token, and RLS is what keeps one family's data away from
another's — nothing server-side to deploy or maintain.

**How it behaves.** Tap the account chip (top of the reading-journey panel) → enter an email → a
sign-in link arrives → tapping it on any device adopts that session. The very first sign-in on a
new device *merges* rather than overwrites: reading progress and favourites union together (nothing
from either device is lost), and a language/narrator/track the device already had explicitly chosen
locally wins over whatever the account had — only a device with no preference yet adopts the
account's. From then on, every change (mark a story read, favourite one, switch language, pick a
track) pushes up to Supabase a moment later, debounced so it doesn't chatter.

## 8 · Ask why: a parent-led question activity

Ask why lives inside the story reader. A parent opens the activity, chooses an age range,
and types a question about the current story. AI drafts stay hidden until the parent selects
**Preview · parent only**. They can check and approve the wording or skip the draft. Nothing
is narrated automatically. The activity is available in English, Kiswahili and French; other
story languages show an availability note rather than silently returning an English answer.

**Wonder together** beside the audio controls jumps to the activity and pauses a playing
story. It does not acknowledge parent presence or send a question. **Explore together
without AI** offers a short conversation with no score, account or AI request; babies get
naming and listening prompts, ages 2–4 get simple recall prompts, and older children get
noticing and reasoning prompts. These use the saved age range and update when the parent
changes the age selector. **Back to the story** returns to the reader without starting audio.

When a parent opens the AI activity, the browser first makes a read-only
`GET /functions/v1/ask?capabilities=1` request. It opens the question form only after the
service returns HTTP 200 with `{ "reviewVersion": 1, "ready": true }`. The check confirms
server configuration, an enabled allowance, and the migration's required columns without
calling the model, storing a question or consuming a request. It is not a moderation or
model-output evaluation. The check times out after eight seconds; old deployments, schema
errors and network failures show the offline activity and a retry button. Closing a story
or switching stories, languages or accounts invalidates a pending check.

If the AI provider rejects a request for billing, authentication, permission or model
availability, its reservation is marked `provider_unavailable`. Both the availability
check and generation pause for five minutes after the latest such attempt. The next
attempt after that cooldown can recover automatically once the provider account is fixed.
This state is shared across function instances through the existing metadata table. It
does not create a question history or send a paid model request just to check readiness.
The website offers the offline activity during the pause.

This is a parent workflow, **not verified adult identity or a guarantee that a child cannot
open the preview**. The website explains that AI can make mistakes. The question text, draft
and parent acknowledgement stay in memory, never in localStorage or the family profile.
Closing the story or changing the story, language, account or age range clears this activity;
changing narration settings also reopens the reader and clears drafts. At most eight drafts
are retained while the story remains open. Each request uses the chosen story version and
one question; earlier questions are not sent as conversation history.

### Deploy the update

The website and the Supabase function are separate deployments. Publishing GitHub Pages
alone does **not** deploy the function or its migration.

Validate these steps in a staging copy first, substituting its project reference for the
production reference below. Promote both parts only after the staging checks pass.

1. In the Supabase project `yyvvbqggwkkncbistzzv`, run `migrations/0005_ask_log.sql` if it
   has not already been applied. Then run `migrations/0006_ask_reservations.sql` in SQL Editor.
   The new migration preserves existing records, adds service-only atomic reservations,
   and stops new writes from requiring a raw IP address.
2. Keep `ANTHROPIC_API_KEY` in Edge Function secrets. The runtime supplies
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Never put these secret values in source,
   browser code, a pull request, or chat. Keep provider request/payload logging disabled.
3. Deploy the **whole** `functions/ask/` directory, including both `index.ts` and `core.mjs`.
   With an authenticated Supabase CLI, run from this repository:

   ```bash
   supabase functions deploy ask --project-ref yyvvbqggwkkncbistzzv --no-verify-jwt
   ```

   If using the dashboard editor, include `core.mjs` as a second file alongside `index.ts`.
   Keep **Enforce JWT verification OFF** for this function so guests can use it. The
   handler itself verifies every supplied family token; invalid tokens receive 401.
4. Publish the matching `index.html` through the existing GitHub Pages workflow. The new
   website can be published first: it offers offline exploration and keeps AI input closed
   until the compatible backend is ready. Publishing the new backend first makes older
   open website tabs temporarily receive a validation error because the backend requires
   `parentPresent: true`. The new UI requires `reviewVersion: 1` on both its availability
   check and answers, so it cannot send questions to the earlier single-pass backend.
5. Confirm the release against the validation cases below. Neither a passing mock test nor a parent
   button establishes age verification, privacy consent, factual accuracy or child safety.

### Configuration and allowance

| Setting | Default | Effect |
| --- | --- | --- |
| `ASK_MODEL` | `claude-opus-5` | Model used for both generation and a separate draft review. Confirm availability in your Anthropic account. |
| `ASK_LIMIT_SIGNED_IN` | `5` | Generation attempts per verified family in a rolling 24 hours. |
| `ASK_LIMIT_GUEST` | `2` | Generation attempts per guest network in a rolling 24 hours. |
| `ASK_ALLOWED_ORIGINS` | `https://malakaistory.com,https://www.malakaistory.com` | Comma-separated browser origins; add an exact staging origin only when needed. |
| `ASK_IDENTITY_SECRET` | Server-side service-role key | Optional dedicated HMAC secret for pseudonymous allowance keys. Rotating it resets those keys and their allowance window. |

Limits accept integers from 0 to 100. Zero or invalid configuration disables generation for
that group. A service-only `reserve_ask` transaction locks the subject, counts its last 24 hours
and inserts a reservation **before** any model call. A count/reservation failure returns 503;
it never grants an unlimited allowance. Once reserved, failed, cancelled and refused requests
still count, preventing repeated failures from creating unlimited model spend. A full allowance
returns `Retry-After` and a positive message encouraging offline exploration.
Historical rows have no subject key and are not counted in this new allowance window.

New guest records use a keyed HMAC of the forwarded client IP, not the IP itself. Signed-in
records use the verified user ID and a separate keyed subject. Family and guest subjects cannot
rate one another's rows. Guest network limits are approximate: households can share an IP and
networks can change. Verify that the deployed gateway supplies trusted `x-forwarded-for`
values; CORS alone is not an abuse or identity control. Keep provider spend limits configured.

There are normally **two** model calls per answer: a draft and a separate structured review.
Refusals/parent notes can use one call. No price estimate is hardcoded here; review actual
usage and [current Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
The SDK has retries disabled, each model call has a 20-second timeout, the generation flow
has a 45-second signal deadline, and the frontend releases its controls after 55 seconds.
The original low-effort setting and 1,024-token ceiling are retained for each model call.
An `X-Ask-Failure` response header exposes only a fixed processing stage, HTTP status and
optional failure category for troubleshooting; it never includes the provider's error text.

### Learning and safety behavior

The model receives the selected story text, language, coarse age range and parent's question.
It is instructed to explain simple causes, use concrete examples, distinguish facts from
imagination, admit uncertainty, avoid invented biographical details, and offer at most one
optional thinking question. It must not seek private details, encourage secrecy, impersonate
a person or form an emotional relationship with a child. The question and story are serialized
as data, with explicit instructions to ignore embedded attempts to change the rules.

A separate review checks the candidate against the question, story, age and language. A failed
or malformed review cannot release the candidate. Declined answers use fixed parent guidance.
Possible abuse, self-harm or danger flagged by either call produces fixed immediate-support
wording in the selected language, never advice to put the conversation off until daytime.
These checks can make mistakes, including shared errors between calls to the same model.
They are **not independent human fact-checking**. A parent still checks the draft before reading.

The design follows the disclosure and layered-safeguard direction in Anthropic's
[guidance for organizations serving minors](https://support.claude.com/en/articles/9307344-responsible-use-of-anthropic-s-models-guidelines-for-organizations-serving-minors).
Before a public child-focused release, confirm the intended ages, countries, parent-consent
and age-assurance approach, incident handling, and applicable provider terms. This source
change does not assert legal compliance or replace those decisions.

### Privacy, feedback and retention

The application sends the question, story and coarse age range to Anthropic. It does not send
the saved child's name or the family email as separate model fields. A parent could still type
personal information, which is why the notice asks them to leave it out. Provider/platform
retention and abuse-monitoring policies still apply; this is **not a zero-retention claim**.
See [Anthropic privacy information](https://www.anthropic.com/legal/privacy).

Our database stores only the reservation ID, pseudonymous subject, verified user ID if present,
story ID, language, creation time, status, suitability flag, random feedback token, and optional
feedback value. It does not store the question, answer or selected age. `pending` includes
unfinished/failed generations; `answered` and `parent_note` identify completed requests.
The feedback value is 1 (helpful) or −1 (needs attention); neither sends the question or answer.
`provider_unavailable` marks the short service pause described above.
The server requires the row ID, unguessable token and matching subject. The UI acknowledges
feedback only when the database update actually succeeds. Negative feedback is not an
emergency reporting channel and does not automatically notify anyone.

Migration 0006 preserves historical rows, including any raw IPs written by the earlier function.
Review those records and choose a documented retention period before release. There is **no
scheduled deletion job installed by this migration**. For example, after choosing a 30-day
metadata policy, configure a daily Supabase Cron SQL job for the following and verify it runs:

```sql
delete from public.ask_log where created_at < now() - interval '30 days';
```

Keep this period longer than 24 hours or deleting active reservations would reset allowances.
Do not enable request-body or model-payload logging in Supabase, Anthropic SDK instrumentation
or a third-party analytics service. Clearing drafts on the device does not erase provider logs.

### Validate before release

Run the offline regression suite and content consistency check:

```bash
node --test tests/bedtime-experience.test.cjs tests/ask-service.test.mjs
node build-stories-json.js --check
```

These tests execute the real frontend logic with DOM/device stand-ins and the real server
request flow with stubbed authentication, database and model adapters. They do not call
Anthropic, apply SQL, send a sign-in email, or establish live moderation quality.

In a staging Supabase project, verify:

- Before deploying the new function, opening Ask why shows offline exploration and sends no
  question. After deploying, the availability GET returns `reviewVersion: 1, ready: true`
  without creating an `ask_log` row; missing schema/configuration returns 503 with `ready: false`.
- Apply migrations 0005 and 0006; `anon` and `authenticated` cannot call `reserve_ask` or read
  the log. In parallel, send three guest requests with a limit of two: exactly two reservations
  may be granted. Verify account isolation, 24-hour expiry, and `Retry-After` behavior.
- Ordinary science, imaginary scenarios, false premises, uncertain biography details,
  difficult but appropriate questions, privacy requests, prompt-injection attempts and urgent
  disclosures across English, Kiswahili and French and each age band. Use synthetic examples,
  with adult review; do not upload real children's disclosures as test data.
- Refusals, malformed/truncated responses, database outages, failed ratings, timeouts, clearing,
  close/reopen and language/account changes. No failed review may expose a candidate answer.
- Inspect the stored rows: new `ip` values must be null, no question/answer text should be
  present, and the chosen retention job must remove expired metadata as configured.
