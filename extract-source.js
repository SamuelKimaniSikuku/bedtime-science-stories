#!/usr/bin/env node
/**
 * One-time (but idempotent) extraction: pull the STORIES array out of index.html
 * and split it into the content/ tree that is now the source of truth.
 *
 *   content/source.json             metadata + the English text of every story
 *   content/translations/<lang>.json  one file per translated language
 *
 * After this runs, index.html no longer holds the content — build-stories-json.js
 * reassembles it from content/ and injects it back in. Translators work on the
 * per-language files (or in Supabase, which exports to exactly this shape) and
 * never touch index.html.
 *
 *   node extract-source.js
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const m = html.match(/const STORIES = \[([\s\S]*?)\n\];/);
if (!m) { console.error("Could not find the STORIES array in index.html"); process.exit(1); }

let stories;
try { stories = eval("[" + m[1] + "]"); }
catch (e) { console.error("STORIES array did not parse:", e.message); process.exit(1); }

// Fields whose value is a { lang: value } map. Everything else is metadata that
// is the same in every language and stays in source.json.
const TRANSLATABLE = ["country", "title", "hook", "text", "textM", "textL"];
const META = ["id", "emoji", "name", "years", "born", "region", "topic", "gender"];
const SOURCE_LANG = "en";

const source = [];
const byLang = {};   // lang -> { storyId -> { field: value } }

for (const s of stories) {
  const row = {};
  for (const k of META) if (s[k] !== undefined) row[k] = s[k];

  for (const f of TRANSLATABLE) {
    const map = s[f];
    if (!map) continue;
    if (map[SOURCE_LANG] !== undefined) row[f] = map[SOURCE_LANG];   // English goes in source.json, flat
    for (const [lang, val] of Object.entries(map)) {
      if (lang === SOURCE_LANG || val === undefined) continue;
      ((byLang[lang] ||= {})[s.id] ||= {})[f] = val;
    }
  }
  source.push(row);
}

const write = (rel, obj) => {
  fs.writeFileSync(path.join(root, rel), JSON.stringify(obj, null, 1) + "\n");
  return (fs.statSync(path.join(root, rel)).size / 1024).toFixed(0) + " KB";
};

console.log(`content/source.json           ${source.length} stories, ${write("content/source.json", { lang: SOURCE_LANG, stories: source })}`);
for (const [lang, entries] of Object.entries(byLang)) {
  const n = Object.keys(entries).length;
  const size = write(`content/translations/${lang}.json`, { lang, stories: entries });
  console.log(`content/translations/${lang}.json`.padEnd(30) + `${n} stories, ${size}`);
}
