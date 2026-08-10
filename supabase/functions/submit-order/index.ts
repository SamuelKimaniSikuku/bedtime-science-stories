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
    // The page sends up to three takes as "samples"; "sample" is kept as the
    // first one so an older page still works against this function.
    const sample = form.get("sample");
    const extras = form.getAll("samples").filter((f): f is File => f instanceof File);
    const allSamples = (extras.length ? extras : (sample instanceof File ? [sample] : [])).slice(0, 3);
    const extOf = (f: File) =>
      (f.type.includes("mp4") || f.type.includes("aac")) ? "m4a"
        : f.type.includes("mpeg") ? "mp3" : "webm";

    // Store every take and return the paths; the first is the canonical one.
    const storeTakes = async (
      supabase: ReturnType<typeof createClient>, tok: string, upsert: boolean,
    ) => {
      const paths: string[] = [];
      for (let i = 0; i < allSamples.length; i++) {
        const f = allSamples[i];
        const p = `${tok}/take-${i + 1}.${extOf(f)}`;
        const { error } = await supabase.storage.from("samples")
          .upload(p, f, { contentType: f.type || "audio/webm", upsert });
        if (error) throw new Error(error.message);
        paths.push(p);
      }
      return paths;
    };

    const isRedo = String(form.get("redo_token") ?? "").trim() !== "";
    if (!consent || !(sample instanceof File)) {
      return json({ error: "Missing consent or recording." }, 400);
    }
    if (!isRedo && (!parent || !email || !langs.length)) {
      return json({ error: "Missing name, email, consent or recording." }, 400);
    }
    const totalBytes = allSamples.reduce((n, f) => n + f.size, 0);
    if (totalBytes < 20_000) return json({ error: "Recording too short — please record again." }, 400);
    if (totalBytes > 60_000_000) return json({ error: "Recordings too large." }, 400);

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

      let rPaths: string[];
      try { rPaths = await storeTakes(supabase, redoToken, true); }
      catch (e) { return json({ error: "Could not store recording: " + String(e) }, 500); }

      // stale manifest would make the player use old-voice files — remove it
      await supabase.storage.from("voicepacks").remove([`${redoToken}/manifest.json`]).catch(() => {});

      const { error: rDbErr } = await supabase.from("orders").update({
        sample_path: rPaths[0], sample_paths: rPaths, voice_id: null, done_keys: [], error: null,
        status: order.status === "new" ? "new" : "paid",
      }).eq("id", order.id);
      if (rDbErr) return json({ error: "Could not update order: " + rDbErr.message }, 500);
      return json({ ok: true, token: redoToken, redo: true });
    }
    // ---- normal new order ----

    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    let paths: string[];
    try { paths = await storeTakes(supabase, token, false); }
    catch (e) { return json({ error: "Could not store recording: " + String(e) }, 500); }

    const { error: dbErr } = await supabase.from("orders").insert({
      token, parent_name: parent, child_name: child || null, email,
      package: pkg, langs, sample_path: paths[0], sample_paths: paths,
    });
    if (dbErr) return json({ error: "Could not create order: " + dbErr.message }, 500);

    return json({ ok: true, token });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
