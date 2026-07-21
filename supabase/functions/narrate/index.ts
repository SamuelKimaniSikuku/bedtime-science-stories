// narrate — public pay-as-listened narration for the site's stock voices.
// POST {story, lang, voice}. First listener triggers generation (~1k credits);
// the mp3 is cached in the public "voicepacks" bucket under house-{voice}/ forever after.
// Only whitelisted voices below can be used, which bounds the maximum possible spend.
// Deploy with "Enforce JWT verification" turned OFF.

import { createClient } from "jsr:@supabase/supabase-js@2";

const XI = "https://api.elevenlabs.io/v1";
const STORIES_URL = "https://malakaistory.com/stories.json";

// ElevenLabs premade voices offered on the site. To change a voice: elevenlabs.io →
// Voices → open a voice → copy its ID, replace it here, and redeploy this function.
const VOICES: Record<string, string> = {
  sarah:  "EXAVITQu4vr4xnSDxMaL",  // warm female
  george: "JBFqnCBsd6RMkjVDRZzb",  // warm male
};

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
    const { story, lang, voice } = await req.json();
    if (!VOICES[voice]) return json({ error: "unknown voice" }, 400);
    if (!["en", "sw", "fr"].includes(lang)) return json({ error: "unknown language" }, 400);
    if (typeof story !== "string" || !/^[a-z0-9-]{1,40}$/.test(story)) return json({ error: "bad story id" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const path = `house-${voice}/${story}-${lang}.mp3`;
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
    const text = [pack.title, ...pack.text].join("\n\n");

    const r = await fetch(`${XI}/text-to-speech/${VOICES[voice]}?output_format=mp3_44100_128`, {
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
