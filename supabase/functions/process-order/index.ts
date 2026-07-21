// process-order — admin endpoint used by admin.html.
// Every call must include header  x-admin-key: <your ADMIN_KEY secret>.
// Actions: list · mark_paid · clone · batch · delete_voice
// Deploy with "Enforce JWT verification" turned OFF (it authenticates via x-admin-key).
//
// Required secrets (Dashboard → Edge Functions → Secrets):
//   ELEVENLABS_API_KEY  — your ElevenLabs key (needs Voices read/write + Text to Speech)
//   ADMIN_KEY           — any long random password you choose; also entered in admin.html

import { createClient } from "jsr:@supabase/supabase-js@2";

const XI = "https://api.elevenlabs.io/v1";
const STORIES_URL = "https://malakaistory.com/stories.json";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-admin-key") !== Deno.env.get("ADMIN_KEY")) {
    return json({ error: "unauthorized" }, 401);
  }
  const xiKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!xiKey) return json({ error: "ELEVENLABS_API_KEY secret is not set" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json();
    const action = body.action as string;

    if (action === "list") {
      const { data, error } = await supabase.from("orders")
        .select("*").order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ orders: data });
    }

    const { data: order, error: findErr } = await supabase.from("orders")
      .select("*").eq("token", body.token).single();
    if (findErr || !order) return json({ error: "order not found" }, 404);

    if (action === "mark_paid") {
      await supabase.from("orders").update({ status: "paid", error: null }).eq("id", order.id);
      return json({ ok: true });
    }

    if (action === "clone") {
      if (order.voice_id) return json({ ok: true, voice_id: order.voice_id, note: "already cloned" });
      const { data: file, error: dlErr } = await supabase.storage.from("samples").download(order.sample_path);
      if (dlErr || !file) return json({ error: "cannot read sample: " + (dlErr?.message ?? "missing") }, 500);
      const fd = new FormData();
      fd.append("name", `${order.parent_name} · ${order.token}`);
      fd.append("files", file, order.sample_path.split("/").pop() ?? "sample.webm");
      const r = await fetch(`${XI}/voices/add`, { method: "POST", headers: { "xi-api-key": xiKey }, body: fd });
      if (!r.ok) {
        const msg = await xiError(r);
        await supabase.from("orders").update({ error: "clone: " + msg }).eq("id", order.id);
        return json({ error: "ElevenLabs clone failed: " + msg }, 502);
      }
      const { voice_id } = await r.json();
      await supabase.from("orders").update({ voice_id, status: "generating", error: null }).eq("id", order.id);
      return json({ ok: true, voice_id });
    }

    if (action === "batch") {
      if (!order.voice_id) return json({ error: "no voice clone yet — run clone first" }, 400);
      const stories = await (await fetch(STORIES_URL)).json();
      const wanted: string[] = [];
      for (const s of stories) for (const l of order.langs) wanted.push(`${s.id}-${l}`);
      const done: string[] = order.done_keys ?? [];
      const missing = wanted.filter((k) => !done.includes(k));
      const batch = missing.slice(0, Math.max(1, Math.min(5, Number(body.batch_size) || 3)));

      for (const key of batch) {
        const dash = key.lastIndexOf("-");
        const id = key.slice(0, dash), lang = key.slice(dash + 1);
        const story = stories.find((s: { id: string }) => s.id === id);
        const pack = story?.langs?.[lang];
        if (!pack) { done.push(key); continue; }  // story/language vanished — skip
        const text = [pack.title, ...pack.text].join("\n\n");
        const r = await fetch(`${XI}/text-to-speech/${order.voice_id}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": xiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: "eleven_v3" }),
        });
        if (!r.ok) {
          const msg = await xiError(r);
          await supabase.from("orders").update({ done_keys: done, error: `tts ${key}: ${msg}` }).eq("id", order.id);
          return json({ error: `TTS failed on ${key}: ${msg}`, done: done.length, total: wanted.length }, 502);
        }
        const audio = await r.blob();
        const { error: upErr } = await supabase.storage.from("voicepacks")
          .upload(`${order.token}/${key}.mp3`, audio, { contentType: "audio/mpeg", upsert: true });
        if (upErr) return json({ error: `store ${key}: ${upErr.message}`, done: done.length, total: wanted.length }, 500);
        done.push(key);
      }

      const finished = done.length >= wanted.length;
      if (finished) {
        const manifest = new Blob([JSON.stringify({
          parent: order.parent_name, child: order.child_name,
          files: done, generated: new Date().toISOString(),
        })], { type: "application/json" });
        await supabase.storage.from("voicepacks")
          .upload(`${order.token}/manifest.json`, manifest, { contentType: "application/json", upsert: true });
      }
      await supabase.from("orders").update({
        done_keys: done, status: finished ? "done" : "generating", error: null,
      }).eq("id", order.id);
      return json({ ok: true, done: done.length, total: wanted.length, finished });
    }

    if (action === "delete_voice") {
      if (order.voice_id) {
        await fetch(`${XI}/voices/${order.voice_id}`, { method: "DELETE", headers: { "xi-api-key": xiKey } });
        await supabase.from("orders").update({ voice_id: null }).eq("id", order.id);
      }
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function xiError(r: Response): Promise<string> {
  try {
    const j = await r.json();
    return j.detail?.message ?? j.detail?.status ?? JSON.stringify(j.detail ?? j);
  } catch { return `HTTP ${r.status}`; }
}
