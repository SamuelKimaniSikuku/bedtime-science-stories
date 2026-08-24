#!/usr/bin/env node
/**
 * Export approved work out of Supabase into content/translations/<lang>.json,
 * which build-stories-json.js then assembles into the site.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node pull-translations.js
 *   ... node pull-translations.js bxk            just one language
 *   ... node pull-translations.js --force        allow a language to shrink
 *
 * Then: node build-stories-json.js && git commit
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const FORCE = process.argv.includes("--force");
const only = process.argv.slice(2).filter(a => !a.startsWith("--"));

if (!URL || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.");
  process.exit(1);
}

const LIST_FIELDS = new Set(["text", "textM", "textL"]);
const SHRINK_LIMIT = 0.9;   // a pull that drops >10% of a language is probably a mistake

const api = (p) => fetch(`${URL}/rest/v1/${p}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(async r => {
  if (!r.ok) { console.error(`${p}: ${r.status} ${await r.text()}`); process.exit(1); }
  return r.json();
});

// PostgREST caps a response, so page through.
async function all(table, query) {
  const out = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const page = await api(`${table}?${query}&limit=${SIZE}&offset=${from}`);
    out.push(...page);
    if (page.length < SIZE) return out;
  }
}

(async () => {
  const langs = (await api("languages?select=code,status"))
    .filter(l => (only.length ? only.includes(l.code) : l.status !== "draft"))
    .map(l => l.code);
  if (!langs.length) { console.error("No matching languages."); process.exit(1); }

  for (const lang of langs) {
    const rows = await all(
      "translations",
      `select=body,segment_id,segments(story,field,idx)&lang=eq.${lang}` +
      `&status=in.(approved,published)&body=not.is.null&order=segment_id`
    );

    const stories = {};
    for (const r of rows) {
      const s = r.segments;
      if (!s) continue;
      const entry = (stories[s.story] ||= {});
      if (LIST_FIELDS.has(s.field)) (entry[s.field] ||= [])[s.idx] = r.body;
      else entry[s.field] = r.body;
    }

    // A gap in a paragraph array would render as an empty paragraph, so drop any
    // field that isn't complete and contiguous — it just isn't finished yet.
    let dropped = 0;
    for (const [id, entry] of Object.entries(stories)) {
      for (const field of LIST_FIELDS) {
        const arr = entry[field];
        if (!arr) continue;
        if (arr.length === 0 || [...arr].some(p => p == null)) { delete entry[field]; dropped++; }
      }
      if (!Object.keys(entry).length) delete stories[id];
    }

    const file = path.join(root, `content/translations/${lang}.json`);
    const before = fs.existsSync(file)
      ? Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).stories || {}).length : 0;
    const after = Object.keys(stories).length;

    if (before && after < before * SHRINK_LIMIT && !FORCE) {
      console.error(`${lang}: would drop from ${before} to ${after} stories — refusing. ` +
        `Check the queue, or re-run with --force.`);
      continue;
    }

    fs.writeFileSync(file, JSON.stringify({ lang, stories }, null, 1) + "\n");
    console.log(`content/translations/${lang}.json  ${after} stories, ${rows.length} approved segments` +
      (dropped ? `  (${dropped} incomplete field(s) held back)` : ""));
  }
  console.log("\nNow run: node build-stories-json.js");
})();
