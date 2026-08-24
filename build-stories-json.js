#!/usr/bin/env node
/**
 * Rebuild the site's content from content/ — the source of truth since the
 * translation pipeline landed.
 *
 *   content/source.json              metadata + English text
 *   content/translations/<lang>.json one file per language (exported from Supabase
 *                                    by pull-translations.js, or hand-edited)
 *        ↓
 *   index.html   the STORIES array is regenerated in place
 *   stories.json the narrate edge function reads this to generate audio
 *
 * Nobody translating a story ever edits index.html: they work in the Supabase
 * queue (or a single language file), and this script assembles the site.
 *
 *   node build-stories-json.js            build
 *   node build-stories-json.js --check    verify only, write nothing
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const CHECK = process.argv.includes("--check");

const SOURCE_LANG = "en";
const TRANSLATABLE = ["country", "title", "hook", "text", "textM", "textL"];
const CORE_LANGS = ["en", "sw", "fr"];   // every story must have these
const EXTRA_LANGS = ["ki", "sv"];        // partial translations: included only where present

// ---------------------------------------------------------------- read content
const source = JSON.parse(fs.readFileSync(path.join(root, "content/source.json"), "utf8"));

const transDir = path.join(root, "content/translations");
const translations = {};   // lang -> { storyId -> { field: value } }
for (const file of fs.readdirSync(transDir).filter(f => f.endsWith(".json")).sort()) {
  const t = JSON.parse(fs.readFileSync(path.join(transDir, file), "utf8"));
  const lang = t.lang || path.basename(file, ".json");
  translations[lang] = t.stories || {};
}

// Reassemble the runtime shape: translatable fields become { lang: value } maps.
const stories = source.stories.map(row => {
  const s = {};
  for (const [k, v] of Object.entries(row)) {
    if (!TRANSLATABLE.includes(k)) { s[k] = v; continue; }
    s[k] = { [SOURCE_LANG]: v };
  }
  for (const [lang, byStory] of Object.entries(translations)) {
    const entry = byStory[row.id];
    if (!entry) continue;
    for (const [field, val] of Object.entries(entry)) {
      if (!TRANSLATABLE.includes(field) || val == null) continue;
      (s[field] ||= {})[lang] = val;
    }
  }
  return s;
});

// ------------------------------------------------------------------- validate
const problems = [], drifts = [];
for (const s of stories) {
  for (const l of CORE_LANGS) {
    if (!s.text?.[l]?.length) { problems.push(`${s.id}: missing ${l} text`); continue; }
    if (!s.title?.[l]) problems.push(`${s.id}: missing ${l} title`);
  }
  // Narration joins the paragraphs, so a differing count still reads fine — but it
  // means a translator merged or split one, which breaks paragraph-level review.
  // Worth flagging, not worth blocking the build over.
  for (const field of ["text", "textM", "textL"]) {
    const en = s[field]?.[SOURCE_LANG];
    if (!en) continue;
    for (const [lang, val] of Object.entries(s[field])) {
      if (lang === SOURCE_LANG) continue;
      if (val.length !== en.length)
        drifts.push(`${s.id}: ${lang} ${field} has ${val.length} paragraphs, English has ${en.length}`);
    }
  }
}
if (problems.length) {
  console.error("Refusing to build:\n  " + problems.join("\n  "));
  process.exit(1);
}
if (drifts.length) console.warn(`⚠ paragraph drift (${drifts.length}):\n  ` + drifts.join("\n  "));

// ---------------------------------------------------------------- stories.json
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

// ------------------------------------------------------------------ index.html
let html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const storiesRe = /(const STORIES = \[\n)[\s\S]*?(\n\];)/;
if (!storiesRe.test(html)) {
  console.error("Could not find the STORIES array in index.html");
  process.exit(1);
}
const body = stories.map(s => JSON.stringify(s)).join(",\n");
html = html.replace(storiesRe, (_, open, close) => open + body + close);

// Keep the SEO ItemList (id="ld-storylist" in index.html's <head>) in sync so
// every story is a discoverable, shareable https://malakaistory.com/#id link.
const itemList = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Malakai Stories — bedtime stories that teach",
  numberOfItems: stories.length,
  itemListElement: stories.map((s, i) => ({
    "@type": "ListItem",
    position: i + 1,
    url: `https://malakaistory.com/#${s.id}`,
    name: s.title?.en ? `${s.name} — ${s.title.en}` : s.name,
  })),
};
const ldRe = /(<script type="application\/ld\+json" id="ld-storylist">\n)[\s\S]*?(\n<\/script>)/;
if (ldRe.test(html)) {
  html = html.replace(ldRe, (_, open, close) => open + JSON.stringify(itemList) + close);
} else {
  console.warn("Could not find the ld-storylist <script> block in index.html — SEO ItemList not updated.");
}

// ----------------------------------------------------------------------- write
const storiesJson = JSON.stringify(out);
if (CHECK) {
  const same = (rel, next) => fs.readFileSync(path.join(root, rel), "utf8") === next;
  const drift = [
    same("stories.json", storiesJson) ? null : "stories.json",
    same("index.html", html) ? null : "index.html",
  ].filter(Boolean);
  if (drift.length) { console.error(`Out of date, run the build: ${drift.join(", ")}`); process.exit(1); }
  console.log("Up to date: index.html and stories.json match content/");
  process.exit(0);
}

fs.writeFileSync(path.join(root, "stories.json"), storiesJson);
fs.writeFileSync(path.join(root, "index.html"), html);

const langCount = {};
for (const s of out) for (const l of Object.keys(s.langs)) langCount[l] = (langCount[l] || 0) + 1;
const withM = out.filter(s => s.langs.en.textM).length;
console.log(`stories.json  ${out.length} stories, ${withM} with a 5-minute version`);
console.log(`index.html    STORIES + ld-storylist regenerated`);
console.log(`languages     ${Object.entries(langCount).map(([l, n]) => `${l} ${n}`).join("  ")}`);
