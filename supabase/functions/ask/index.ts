// Runtime adapters for the parent-led Ask why activity.
// Deploy this directory (including core.mjs) after migration 0006.
// Guest requests are allowed; the handler verifies any supplied session itself.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAskHandler, readLimit } from "./core.mjs";

const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
const model = Deno.env.get("ASK_MODEL") || "claude-opus-5";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
// Do not log requests, model messages or exception objects: they can contain
// family text. All failures are translated to fixed public error codes in core.
const db = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, {
    ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(8000)]),
  }) },
}) : null;
const client = apiKey ? new Anthropic({ apiKey, maxRetries: 0, timeout: 20000 }) : null;

let storiesCache: { at: number; data: unknown[] } | null = null;
async function loadStories(signal: AbortSignal) {
  if (storiesCache && Date.now() - storiesCache.at < 600000) return storiesCache.data;
  const response = await fetch("https://malakaistory.com/stories.json", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok) throw new Error("story source unavailable");
  const data = await response.json();
  if (!Array.isArray(data) || !data.length) throw new Error("invalid story source");
  storiesCache = { at: Date.now(), data };
  return data;
}

Deno.serve(createAskHandler({
  ready: !!(db && client),
  identitySecret: Deno.env.get("ASK_IDENTITY_SECRET") || serviceKey,
  origins: (Deno.env.get("ASK_ALLOWED_ORIGINS") || "https://malakaistory.com,https://www.malakaistory.com").split(",").map(s => s.trim()),
  limitGuest: readLimit(Deno.env.get("ASK_LIMIT_GUEST"), 2),
  limitSignedIn: readLimit(Deno.env.get("ASK_LIMIT_SIGNED_IN"), 5),
  loadStories,
  async checkReady() {
    // Migration 0006 creates these columns and reserve_ask in one transaction.
    const { error } = await db!.from("ask_log").select("subject_key,rating_token,status").limit(0);
    return !error;
  },
  async getUser(token: string) {
    const { data, error } = await db!.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  },
  async reserve(values: Record<string, unknown>) {
    const { data, error } = await db!.rpc("reserve_ask", values);
    if (error) throw new Error("allowance unavailable");
    return data;
  },
  async finish(id: number, subject: string, suitable: boolean) {
    const { data, error } = await db!.from("ask_log").update({ suitable, status: suitable ? "answered" : "parent_note" })
      .eq("id", id).eq("subject_key", subject).select("id").maybeSingle();
    if (error || !data) throw new Error("usage record unavailable");
  },
  async rate(id: number, token: string, subject: string, good: boolean) {
    const { data, error } = await db!.from("ask_log").update({ rating: good ? 1 : -1 })
      .eq("id", id).eq("rating_token", token).eq("subject_key", subject)
      .in("status", ["answered", "parent_note"]).select("id").maybeSingle();
    if (error) throw new Error("feedback unavailable");
    return !!data;
  },
  async complete(system: string, content: string, schema: Record<string, unknown>, signal: AbortSignal) {
    return await client!.messages.create({
      model, max_tokens: 900,
      output_config: { format: { type: "json_schema", schema } },
      system, messages: [{ role: "user", content }],
    }, { signal });
  },
}));
