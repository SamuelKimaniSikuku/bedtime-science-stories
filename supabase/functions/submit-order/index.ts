// submit-order — public endpoint the your-voice.html page posts to.
// Stores the parent's voice sample in the private "samples" bucket and creates an order row.
// Deploy with "Enforce JWT verification" turned OFF (it takes no secrets from the caller).

import { createClient } from "jsr:@supabase/supabase-js@2";

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
    const form = await req.formData();
    const parent = String(form.get("parent_name") ?? "").trim();
    const child = String(form.get("child_name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const pkg = String(form.get("package") ?? "one");
    const langs = String(form.get("langs") ?? "en")
      .split(",").map((s) => s.trim()).filter((l) => ["en", "sw", "fr"].includes(l));
    const consent = String(form.get("consent")) === "true";
    const sample = form.get("sample");

    const isRedo = String(form.get("redo_token") ?? "").trim() !== "";
    if (!consent || !(sample instanceof File)) {
      return json({ error: "Missing consent or recording." }, 400);
    }
    if (!isRedo && (!parent || !email || !langs.length)) {
      return json({ error: "Missing name, email, consent or recording." }, 400);
    }
    if (sample.size < 20_000) return json({ error: "Recording too short — please record again." }, 400);
    if (sample.size > 25_000_000) return json({ error: "Recording too large." }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ---- REDO: replace the recording on an existing order ----
    const redoToken = String(form.get("redo_token") ?? "").trim();
    if (redoToken) {
      const { data: order } = await supabase.from("orders").select("*").eq("token", redoToken).single();
      if (!order) return json({ error: "We couldn't find that order — check your redo link." }, 404);

      // delete the old ElevenLabs clone so a fresh one is made from the new sample
      const xiKey = Deno.env.get("ELEVENLABS_API_KEY");
      if (order.voice_id && xiKey) {
        await fetch(`https://api.elevenlabs.io/v1/voices/${order.voice_id}`, {
          method: "DELETE", headers: { "xi-api-key": xiKey },
        }).catch(() => {});
      }

      const rext = (sample.type.includes("mp4") || sample.type.includes("aac")) ? "m4a"
        : sample.type.includes("mpeg") ? "mp3" : "webm";
      const newPath = `${redoToken}/sample.${rext}`;
      const { error: rUpErr } = await supabase.storage.from("samples")
        .upload(newPath, sample, { contentType: sample.type || "audio/webm", upsert: true });
      if (rUpErr) return json({ error: "Could not store recording: " + rUpErr.message }, 500);

      // stale manifest would make the player use old-voice files — remove it
      await supabase.storage.from("voicepacks").remove([`${redoToken}/manifest.json`]).catch(() => {});

      const { error: rDbErr } = await supabase.from("orders").update({
        sample_path: newPath, voice_id: null, done_keys: [], error: null,
        status: order.status === "new" ? "new" : "paid",
      }).eq("id", order.id);
      if (rDbErr) return json({ error: "Could not update order: " + rDbErr.message }, 500);
      return json({ ok: true, token: redoToken, redo: true });
    }
    // ---- normal new order ----

    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const ext = (sample.type.includes("mp4") || sample.type.includes("aac")) ? "m4a"
      : sample.type.includes("mpeg") ? "mp3" : "webm";
    const samplePath = `${token}/sample.${ext}`;

    const { error: upErr } = await supabase.storage.from("samples")
      .upload(samplePath, sample, { contentType: sample.type || "audio/webm" });
    if (upErr) return json({ error: "Could not store recording: " + upErr.message }, 500);

    const { error: dbErr } = await supabase.from("orders").insert({
      token, parent_name: parent, child_name: child || null, email,
      package: pkg, langs, sample_path: samplePath,
    });
    if (dbErr) return json({ error: "Could not create order: " + dbErr.message }, 500);

    return json({ ok: true, token });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
