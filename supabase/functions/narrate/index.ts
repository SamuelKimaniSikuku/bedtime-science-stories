// narrate — public pay-as-listened narration for the site's stock voices.
// POST {story, lang, voice}. First listener triggers generation (~1k credits);
// the mp3 is cached in the public "voicepacks" bucket under house-{voice}/ forever after.
// Only whitelisted voices below can be used, which bounds the maximum possible spend.
// Deploy with "Enforce JWT verification" turned OFF.

import { createClient } from "jsr:@supabase/supabase-js@2";

const XI = "https://api.elevenlabs.io/v1";
const STORIES_URL = "https://malakaistory.com/stories.json";

// ElevenLabs premade voices offered on the site. Each entry is resolved by NAME from the
// account's voice list at runtime (IDs of stock voices change over time); the hardcoded id
// is only a fallback. To offer a different voice, change the name and redeploy.
const VOICES: Record<string, { name: string; id: string }> = {
  sarah:   { name: "Sarah",   id: "EXAVITQu4vr4xnSDxMaL" },  // warm female
  william: { name: "William", id: "" },  // "William - Deep, Engaging Storyteller" from My Voices
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
    const len = ["m", "l"].includes(length) ? length : "short";
    const suffix = len === "m" ? "-m" : len === "l" ? "-l" : "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const path = `house-${voice}/${story}-${lang}${suffix}.mp3`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/voicepacks/${path}`;

    // already generated? serve the cached file
    const head = await fetch(publicUrl, { method: "HEAD" });
    if (head.ok) return json({ url: publicUrl, cached: true });

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

    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: upErr } = await supabase.storage.from("voicepacks")
      .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (upErr) return json({ error: "store failed: " + upErr.message }, 500);

    return json({ url: publicUrl, cached: false });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
