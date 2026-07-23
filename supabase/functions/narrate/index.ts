// narrate — public pay-as-listened narration for the site's stock voices.
// POST {story, lang, voice}. First listener triggers generation (~1k credits);
// the mp3 is cached in the public "voicepacks" bucket under house-{voice}/ forever after.
// Only whitelisted voices below can be used, which bounds the maximum possible spend.
// Deploy with "Enforce JWT verification" turned OFF.

import { createClient } from "jsr:@supabase/supabase-js@2";

const XI = "https://api.elevenlabs.io/v1";
const STORIES_URL = "https://malakaistory.com/stories.json";

// Max NEW (uncached) generations one visitor (IP) may trigger per rolling 24h.
// Cached replays are free and never counted. Raise/lower this one number to taste.
const DAILY_LIMIT = 3;

// Lengths a public visitor is allowed to GENERATE. The 10-minute ("l") length is the
// most expensive per generation, so it is disabled for the public trial. Any request
// for it quietly falls back to the 2-minute version. (Already-cached 10-min files, if
// any exist, still play — they're served from cache before this ever applies.)
const ALLOWED_LENGTHS = ["m"];  // in addition to the default "short"; add "l" to re-enable 10-min

// ElevenLabs premade voices offered on the site. Each entry is resolved by NAME from the
// account's voice list at runtime (IDs of stock voices change over time); the hardcoded id
// is used as a fallback if the name lookup fails. To offer a different voice, change the name.
// Both voices are enabled; the per-IP daily cap still bounds total spend either way.
//
// IMPORTANT: give every voice a real fallback id. If the id is empty AND the name lookup
// fails, the function now refuses to generate (see the guard below) rather than producing
// the wrong voice — but a correct fallback id avoids that failure entirely. Paste William's
// id from ElevenLabs → Voices → William → copy ID.
const VOICES: Record<string, { name: string; id: string }> = {
  sarah:   { name: "Sarah",   id: "EXAVITQu4vr4xnSDxMaL" },  // warm female
  william: { name: "William", id: "" },  // ← paste William's voice ID here (e.g. "abc123...")
};

let voiceListCache: { name: string; voice_id: string }[] | null = null;
async function resolveVoiceId(key: string, xiKey: string): Promise<string> {
  const want = VOICES[key];
  const wantName = want.name.toLowerCase();
  try {
    // Two attempts: if the cached list doesn't contain the voice (e.g. it was added
    // to My Voices a moment ago), refetch the list once before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!voiceListCache) {
        const r = await fetch(`${XI}/voices`, { headers: { "xi-api-key": xiKey } });
        if (r.ok) voiceListCache = (await r.json()).voices ?? [];
      }
      const hit = voiceListCache?.find((v) => v.name?.toLowerCase() === wantName) ??
                  voiceListCache?.find((v) => v.name?.toLowerCase().startsWith(wantName)) ??
                  voiceListCache?.find((v) => v.name?.toLowerCase().includes(wantName));
      if (hit) return hit.voice_id;
      voiceListCache = null;  // stale? refetch on second pass
    }
  } catch { /* fall through to hardcoded id */ }
  return want.id;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { story, lang, voice, length } = await req.json();
    if (!VOICES[voice]) return json({ error: "unknown voice" }, 400);
    if (!["en", "sw", "fr"].includes(lang)) return json({ error: "unknown language" }, 400);
    if (typeof story !== "string" || !/^[a-z0-9-]{1,40}$/.test(story)) return json({ error: "bad story id" }, 400);
    const len = ALLOWED_LENGTHS.includes(length) ? length : "short";
    const suffix = len === "m" ? "-m" : len === "l" ? "-l" : "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const path = `house-${voice}/${story}-${lang}${suffix}.mp3`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/voicepacks/${path}`;

    // already generated? serve the cached file (never rate-limited — replays are free)
    const head = await fetch(publicUrl, { method: "HEAD" });
    if (head.ok) return json({ url: publicUrl, cached: true });

    // --- Rate limit: only reached on a cache MISS, i.e. a real (paid) generation. ---
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: cntErr } = await supabase
      .from("narrate_log")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("created_at", since);
    // Fail open on a counting error (don't block a listener over a logging hiccup),
    // but enforce the cap whenever the count is available.
    if (!cntErr && (count ?? 0) >= DAILY_LIMIT) {
      return json({
        error: "daily limit reached",
        detail: `You can start up to ${DAILY_LIMIT} new narrations per day. Stories that are already made still play for free — try one of those, or come back tomorrow.`,
      }, 429);
    }

    const xiKey = Deno.env.get("ELEVENLABS_API_KEY");
    if (!xiKey) return json({ error: "ELEVENLABS_API_KEY secret is not set" }, 500);

    const stories = await (await fetch(STORIES_URL)).json();
    const s = stories.find((x: { id: string }) => x.id === story);
    const pack = s?.langs?.[lang];
    if (!pack) return json({ error: "story not found" }, 404);
    const paragraphs = len === "m" ? pack.textM : len === "l" ? pack.textL : pack.text;
    if (!paragraphs) return json({ error: "this length is not available for this story" }, 404);
    const text = [pack.title, ...paragraphs].join("\n\n");

    const voiceId = await resolveVoiceId(voice, xiKey);
    // Safety guard: never call ElevenLabs with an empty/unresolved id — doing so is what
    // silently produced the wrong voice before. If we can't resolve it, fail loudly and
    // cache nothing, so a mis-voiced mp3 can never be baked into the bucket again.
    if (!voiceId) {
      return json({ error: `voice "${voice}" is not available in the ElevenLabs account (name not found and no fallback id set)` }, 502);
    }
    const r = await fetch(`${XI}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": xiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_v3" }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = j.detail?.message ?? j.detail?.status ?? msg; } catch { /* ignore */ }
      return json({ error: "generation failed: " + msg }, 502);
    }
    const audio = await r.blob();

    const { error: upErr } = await supabase.storage.from("voicepacks")
      .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (upErr) return json({ error: "store failed: " + upErr.message }, 500);

    // Count this generation against the visitor's daily allowance.
    await supabase.from("narrate_log").insert({ ip, story, lang, voice });

    return json({ url: publicUrl, cached: false });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
