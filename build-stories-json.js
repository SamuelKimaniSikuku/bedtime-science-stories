#!/usr/bin/env node
/**
 * Rebuild stories.json from index.html.
 *
 * index.html is the single source of truth for story content. The narrate edge
 * function (supabase/functions/narrate) fetches stories.json to generate audio,
 * so this file must be regenerated whenever stories are added or changed —
 * otherwise new stories play no narration.
 *
 *   node build-stories-json.js
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const m = html.match(/const STORIES = \[([\s\S]*?)\n\];/);
if (!m) {
  console.error("Could not find the STORIES array in index.html");
  process.exit(1);
}

let stories;
try {
  stories = eval("[" + m[1] + "]");
} catch (e) {
  console.error("STORIES array did not parse:", e.message);
  process.exit(1);
}

const CORE_LANGS = ["en", "sw", "fr"];   // every story must have these
const EXTRA_LANGS = ["ki", "sv"];        // partial translations: included only where present
const out = stories.map(s => {
  const langs = {};
  for (const l of [...CORE_LANGS, ...EXTRA_LANGS]) {
    if (!s.text?.[l]) continue;          // skip languages this story lacks
    const pack = { title: s.title?.[l] || s.title?.en, text: s.text[l] };
    if (s.textM?.[l]) pack.textM = s.textM[l];
    if (s.textL?.[l]) pack.textL = s.textL[l];
    langs[l] = pack;
  }
  return { id: s.id, name: s.name, emoji: s.emoji, langs };
});

// Fail loudly rather than shipping a half-built file the narrator would choke on.
const problems = [];
for (const s of out) {
  for (const l of CORE_LANGS) {
    if (!s.langs[l]) { problems.push(`${s.id}: missing ${l} entirely`); continue; }
    if (!s.langs[l].title) problems.push(`${s.id}: missing ${l} title`);
    if (!Array.isArray(s.langs[l].text) || !s.langs[l].text.length)
      problems.push(`${s.id}: missing ${l} text`);
  }
}
if (problems.length) {
  console.error("Refusing to write stories.json:\n  " + problems.join("\n  "));
  process.exit(1);
}

fs.writeFileSync(path.join(root, "stories.json"), JSON.stringify(out));
const withM = out.filter(s => s.langs.en.textM).length;
console.log(`stories.json written: ${out.length} stories, ${withM} with a 5-minute version`);
