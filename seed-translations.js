#!/usr/bin/env node
/**
 * Push the English source (and the translations that already exist) into Supabase,
 * so the community translation queue has something to serve.
 *
 *   node seed-translations.js               dry run — prints what it would send
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node seed-translations.js --push
 *   ... --push --replace                    re-seed languages that already have rows
 *
 * The service key is read from the environment and never written to disk. Run the
 * migration (supabase/migrations/0003_translations.sql) first.
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const PUSH = process.argv.includes("--push");
const REPLACE = process.argv.includes("--replace");
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const SEED_AUTHOR = "Malakai Stories (seed)";

const TRANSLATABLE = ["country", "title", "hook", "text", "textM", "textL"];
const LIST_FIELDS = new Set(["text", "textM", "textL"]);   // arrays of paragraphs

const source = JSON.parse(fs.readFileSync(path.join(root, "content/source.json"), "utf8"));
const transDir = path.join(root, "content/translations");
const translations = {};
for (const file of fs.readdirSync(transDir).filter(f => f.endsWith(".json")).sort()) {
  const t = JSON.parse(fs.readFileSync(path.join(transDir, file), "utf8"));
  translations[t.lang || path.basename(file, ".json")] = t.stories || {};
}

// --------------------------------------------------------------- build rows
// Every translatable field becomes one or more segments. Arrays are split per
// paragraph so a task is ~40 seconds of work; scalars get idx 0.
const cells = (entry, field) => {
  const v = entry?.[field];
  if (v == null) return [];
  return LIST_FIELDS.has(field) ? v.map((p, i) => [i, p]) : [[0, v]];
};

const segments = [];
let ord = 0;
for (const story of source.stories) {
  for (const field of TRANSLATABLE) {
    for (const [idx, en] of cells(story, field)) {
      segments.push({
        id: `${story.id}:${field}:${idx}`,
        story: story.id, field, idx, en,
        sw: (translations.sw?.[story.id]?.[field] ?? null) === null ? null
          : (LIST_FIELDS.has(field) ? translations.sw[story.id][field][idx] ?? null : translations.sw[story.id][field]),
        words: String(en).split(/\s+/).filter(Boolean).length,
        ord: ord++,
      });
    }
  }
}
const segIds = new Set(segments.map(s => s.id));

const rows = [];
const skipped = {};
for (const [lang, byStory] of Object.entries(translations)) {
  for (const [storyId, entry] of Object.entries(byStory)) {
    for (const field of TRANSLATABLE) {
      for (const [idx, body] of cells(entry, field)) {
        const segment_id = `${storyId}:${field}:${idx}`;
        // A translation with no English counterpart (a merged or extra paragraph)
        // has nothing to hang off — report it rather than silently dropping it.
        if (!segIds.has(segment_id)) { (skipped[lang] ||= []).push(segment_id); continue; }
        rows.push({ segment_id, lang, body, author_name: SEED_AUTHOR, status: "published" });
      }
    }
  }
}

// ------------------------------------------------------------------- report
const byLang = {};
for (const r of rows) byLang[r.lang] = (byLang[r.lang] || 0) + 1;
const words = segments.reduce((n, s) => n + s.words, 0);
console.log(`segments      ${segments.length}  (${words.toLocaleString()} English words)`);
console.log(`translations  ${rows.length}`);
for (const [lang, n] of Object.entries(byLang))
  console.log(`  ${lang.padEnd(4)} ${String(n).padStart(5)}  ${(100 * n / segments.length).toFixed(0)}% of the corpus`);
for (const [lang, list] of Object.entries(skipped))
  console.log(`  ⚠ ${lang}: ${list.length} unmatched segment(s) skipped — ${list.slice(0, 3).join(", ")}`);

if (!PUSH) {
  console.log("\nDry run. Re-run with --push (and SUPABASE_URL / SUPABASE_SERVICE_KEY set) to send.");
  process.exit(0);
}
if (!URL || !KEY) {
  console.error("\nSUPABASE_URL and SUPABASE_SERVICE_KEY must be set to --push.");
  process.exit(1);
}

// --------------------------------------------------------------------- push
const api = (p, init = {}) => fetch(`${URL}/rest/v1/${p}`, {
  ...init,
  headers: {
    apikey: KEY, Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json", ...(init.headers || {}),
  },
});

async function send(table, list, prefer) {
  const SIZE = 500;
  for (let i = 0; i < list.length; i += SIZE) {
    const chunk = list.slice(i, i + SIZE);
    const res = await api(table, { method: "POST", headers: { Prefer: prefer }, body: JSON.stringify(chunk) });
    if (!res.ok) { console.error(`${table} failed at row ${i}: ${res.status} ${await res.text()}`); process.exit(1); }
    process.stdout.write(`\r  ${table}: ${Math.min(i + SIZE, list.length)}/${list.length}`);
  }
  process.stdout.write("\n");
}

(async () => {
  await send("segments", segments, "resolution=merge-duplicates,return=minimal");

  for (const lang of Object.keys(byLang)) {
    const have = await api(`translations?lang=eq.${lang}&select=id&limit=1`).then(r => r.json());
    if (have.length && !REPLACE) { console.log(`  ${lang}: already seeded, skipping (use --replace to redo)`); continue; }
    if (have.length && REPLACE) {
      const del = await api(`translations?lang=eq.${lang}&author_name=eq.${encodeURIComponent(SEED_AUTHOR)}`, { method: "DELETE" });
      if (!del.ok) { console.error(`  ${lang}: delete failed ${del.status} ${await del.text()}`); process.exit(1); }
      console.log(`  ${lang}: cleared previous seed rows`);
    }
    await send("translations", rows.filter(r => r.lang === lang), "return=minimal");
  }
  console.log("Done.");
})();
