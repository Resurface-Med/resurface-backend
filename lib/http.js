// The parts every endpoint needs before it does anything useful: who is
// calling, whether their browser is allowed to, and how fast they are going.
//
// Extracted when a second endpoint arrived. Duplicating an auth check is how
// two endpoints end up disagreeing about who is allowed in.

import { createClient } from "@supabase/supabase-js";

const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://app.tryresurface.com",
  "https://tryresurface.com",
  "https://www.tryresurface.com",
  // Kept so the vercel.app URL keeps working during the domain cutover.
  "https://resurface-app-eight.vercel.app",
];

export function allowedOrigin(origin) {
  // Union, not override. ALLOWED_ORIGINS used to replace this list, which meant
  // a stale env var pointing at an old deployment silently blocked the real
  // domain — a failure that surfaces as a CORS error in someone's browser and
  // nowhere in the logs. The canonical origins are always allowed; the env var
  // can only add to them.
  const fromEnv = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowed = new Set([...DEFAULT_ORIGINS, ...fromEnv]);
  if (!origin) return null;
  return allowed.has(origin) ? origin : null;
}

export function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(body, status, origin) {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

export function preflight(req) {
  return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin(req.headers.get("origin"))) });
}

// The same public values the app ships in its bundle: enough to ask Supabase
// whether a token is valid, and useless for anything else. Defaulting them
// means a missing env var cannot silently turn every request into a 401.
const DEFAULT_SUPABASE_URL = "https://uhqpljteohitvytwfadp.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_0ZlQhc0Gn_bD5-AFIgPOrw_xKVHv8hJ";

/** Resolves the bearer token to a user, or null. Supabase checks the signature. */
export async function verify(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
  if (!token) return null;

  const supabase = createClient(
    process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error) console.error("[auth] token rejected:", error.message);
  return error ? null : data.user;
}

/**
 * Best-effort throttle, per bucket.
 *
 * Serverless instances are recycled, so this caps runaway loops rather than
 * providing real per-user quotas. Each endpoint keeps its own bucket: asking
 * for an explanation is cheap and frequent, generating a lecture's worth of
 * questions is neither, and one should not use up the other's allowance.
 */
const buckets = new Map();

export function rateLimited(bucket, id, max, windowMs = 60_000) {
  const key = `${bucket}:${id}`;
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter(t => now - t < windowMs);
  recent.push(now);
  buckets.set(key, recent);
  return recent.length > max;
}
