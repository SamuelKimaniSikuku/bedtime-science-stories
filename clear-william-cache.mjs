// clear-william-cache.mjs
// Deletes stale William narration files from the Supabase "voicepacks" bucket so they
// regenerate with the correct voice on next play. Keeps Galileo (already correct).
//
// HOW TO RUN (from your terminal, key stays on your machine):
//   export SUPABASE_SERVICE_ROLE_KEY="paste-your-service-role-key"
//   node clear-william-cache.mjs
//
// Get the service_role key from: Supabase dashboard → Settings → API → "service_role" (secret).
// Do a dry run first to see what WOULD be deleted:
//   node clear-william-cache.mjs --dry-run

const SUPABASE_URL = "https://yyvvbqggwkkncbistzzv.supabase.co";
const BUCKET = "voicepacks";
const FOLDER = "house-william";
const KEEP_STORY_IDS = ["galileo"];        // already correct — leave these cached
const DRY_RUN = process.argv.includes("--dry-run");

const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  console.error("ERROR: set SUPABASE_SERVICE_ROLE_KEY first, e.g.\n  export SUPABASE_SERVICE_ROLE_KEY=\"...\"");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  apikey: key,
  Authorization: `Bearer ${key}`,
};

// 1) List everything in house-william/
const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    prefix: FOLDER,
    limit: 1000,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
  }),
});
if (!listRes.ok) {
  console.error("List failed:", listRes.status, await listRes.text());
  process.exit(1);
}
const objects = await listRes.json();

// 2) Keep only real files, drop the ones we want to preserve
const files = objects.filter((o) => o && o.id); // folders have id === null
const keep = (name) => KEEP_STORY_IDS.some((id) => name === `${id}.mp3` || name.startsWith(`${id}-`));
const toDelete = files.filter((o) => !keep(o.name)).map((o) => `${FOLDER}/${o.name}`);
const kept = files.filter((o) => keep(o.name)).map((o) => o.name);

console.log(`Found ${files.length} file(s) in ${FOLDER}/.`);
if (kept.length) console.log(`Keeping (already correct): ${kept.join(", ")}`);
console.log(`${DRY_RUN ? "WOULD delete" : "Deleting"} ${toDelete.length} file(s):`);
toDelete.forEach((p) => console.log("  " + p));

if (toDelete.length === 0) { console.log("Nothing to delete."); process.exit(0); }
if (DRY_RUN) { console.log("\nDry run — nothing was deleted. Re-run without --dry-run to delete."); process.exit(0); }

// 3) Delete them (batched to be safe)
const BATCH = 100;
let done = 0;
for (let i = 0; i < toDelete.length; i += BATCH) {
  const prefixes = toDelete.slice(i, i + BATCH);
  const delRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ prefixes }),
  });
  if (!delRes.ok) {
    console.error("Delete failed:", delRes.status, await delRes.text());
    process.exit(1);
  }
  done += prefixes.length;
  console.log(`Deleted ${done}/${toDelete.length}...`);
}
console.log(`\nDone. ${done} stale William file(s) removed — they'll regenerate with the correct voice on next play.`);
