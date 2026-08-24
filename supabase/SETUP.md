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
