// Question generation. Holds the Anthropic key so it never reaches a browser.
//
// The system prompt is built here rather than accepted from the client, so this
// endpoint can only ever produce MBChB multiple-choice questions — it cannot be
// repurposed as a free general-purpose Claude proxy.

import { createClient } from "@supabase/supabase-js";

const MAX_COUNT = 20;

const DIFF_DESC = {
  easy:   "direct single-fact recall (where/what/which enzyme)",
  medium: "mechanism/application (why does X, what happens if Y inhibited)",
  hard:   "clinical vignette — every question must open with a patient scenario",
};

// Best-effort throttle. Serverless instances are recycled, so this caps runaway
// loops rather than providing real per-user quotas. Swap for Upstash Redis if
// the access code ever leaks beyond the group.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

function rateLimited(id) {
  const now = Date.now();
  const recent = (hits.get(id) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(id, recent);
  return recent.length > MAX_PER_WINDOW;
}

const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://resurface-app-eight.vercel.app",
].join(",");

function allowedOrigin(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// Same public values the app ships in its bundle: enough to ask Supabase
// whether a token is valid, and useless for anything else. Defaulting them
// means a missing env var can't silently turn every request into a 401.
const DEFAULT_SUPABASE_URL = "https://uhqpljteohitvytwfadp.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_0ZlQhc0Gn_bD5-AFIgPOrw_xKVHv8hJ";

/** Resolves the bearer token to a user, or null. Supabase checks the signature. */
async function verify(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
  if (!token) return null;

  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

  const supabase = createClient(url, anonKey);
  const { data, error } = await supabase.auth.getUser(token);
  if (error) console.error("[generate] token rejected:", error.message);
  return error ? null : data.user;
}

function json(body, status, origin) {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

export async function OPTIONS(req) {
  const origin = allowedOrigin(req.headers.get("origin"));
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req) {
  const origin = allowedOrigin(req.headers.get("origin"));

  // A shared access code couldn't be revoked for one person and told us
  // nothing about who was calling. The session token does both: Supabase
  // verifies the signature, and we get a user id to rate limit against.
  const user = await verify(req);
  if (!user) return json({ error: "Sign in to generate questions." }, 401, origin);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500, origin);
  }

  if (rateLimited(user.id)) {
    return json({ error: "Slow down — too many generations. Try again in a minute." }, 429, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request body." }, 400, origin); }

  const { userContent, difficulty = "medium", count = 5 } = body || {};
  if (!Array.isArray(userContent) || userContent.length === 0) {
    return json({ error: "No content to generate from." }, 400, origin);
  }

  const n = Math.min(Math.max(parseInt(count) || 5, 1), MAX_COUNT);
  const diffDesc = DIFF_DESC[difficulty] || DIFF_DESC.medium;

  const systemPrompt = `MCQ generator for Year 1 MBChB. Output ONLY a JSON array, no markdown.
Rules: ${n} questions, 5 opts each, difficulty=${diffDesc}.
Options: all 5 must be equal length (±3 words), parallel grammar, plausible distractors.
exp=2 sentences why correct. optExp=1 sentence why each wrong opt is wrong (null at ans index).
Vary ans position. Schema: [{"q":"...","opts":[...],"ans":N,"exp":"...","optExp":[...]}]`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      // Never leak upstream account details to the client.
      const upstreamAuthFailed = r.status === 401 || r.status === 403;
      return json(
        { error: upstreamAuthFailed ? "Server API key was rejected." : err?.error?.message || `Upstream error ${r.status}` },
        upstreamAuthFailed ? 500 : r.status,
        origin,
      );
    }

    const data = await r.json();
    const text = data.content?.[0]?.text || "";
    const clean = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return json({ error: "Claude returned invalid JSON. Try again." }, 502, origin); }

    if (!Array.isArray(parsed)) {
      return json({ error: "Expected a JSON array from Claude." }, 502, origin);
    }

    return json({ questions: parsed }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Generation failed." }, 500, origin);
  }
}
