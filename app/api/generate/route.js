// Question generation. Holds the model API key so it never reaches a browser.
//
// The system prompt is built here rather than accepted from the client, so this
// endpoint can only ever produce MBChB multiple-choice questions — it cannot be
// repurposed as a free general-purpose model proxy.
//
// Two providers live here on purpose. The client's request shape does not
// change when the provider does, and which one runs is decided by which key is
// present, so the cutover is an environment variable rather than a deploy:
// set GEMINI_API_KEY and generation moves to Gemini; unset it and it is back on
// Anthropic in the time it takes Vercel to redeploy. That matters because this
// endpoint is the one part of the app that costs money per use, and the ability
// to fall back without shipping code is worth one branch.

import { createClient } from "@supabase/supabase-js";

const MAX_COUNT = 20;

// The free tier's Flash model still carries its -preview suffix: "gemini-3-flash"
// is rejected outright, which is a better failure than a silent fallback, but
// only if the name is right. Overridable, so switching model — to a stable
// paid one, or a cheaper Flash-Lite — is an environment variable.
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

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
  "https://app.tryresurface.com",
  "https://tryresurface.com",
  "https://www.tryresurface.com",
  // Kept so the vercel.app URL keeps working during the domain cutover.
  "https://resurface-app-eight.vercel.app",
].join(",");

function allowedOrigin(origin) {
  // Union, not override. ALLOWED_ORIGINS used to replace this list, which meant
  // a stale env var pointing at an old deployment silently blocked the real
  // domain — the failure looks like a CORS error in someone's browser and
  // nowhere in the logs. The canonical origins are always allowed; the env var
  // can only add to them.
  const fromEnv = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowed = new Set([...DEFAULT_ORIGINS.split(","), ...fromEnv]);
  if (!origin) return null;
  return allowed.has(origin) ? origin : null;
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

function systemPrompt(n, diffDesc) {
  return `MCQ generator for Year 1 MBChB. Output ONLY a JSON array, no markdown.
Rules: ${n} questions, 5 opts each, difficulty=${diffDesc}.
Options: all 5 must be equal length (±3 words), parallel grammar, plausible distractors.
exp=2 sentences why correct. optExp=1 sentence why each wrong opt is wrong (empty string at ans index).
Vary ans position. Schema: [{"q":"...","opts":[...],"ans":N,"exp":"...","optExp":[...]}]`;
}

/**
 * What a question has to look like coming back.
 *
 * Declared to the model rather than only described in the prompt, so malformed
 * output is prevented instead of detected. The old path asked for JSON in
 * prose, stripped markdown fences the model added anyway, and returned a 502
 * when the parse failed — a failure the user saw as "try again".
 *
 * optExp carries an empty string at the answer index rather than null: a null
 * inside a typed array is the one thing schema subsets tend to disagree about,
 * and it is normalised back to null below.
 */
const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          q: { type: "string" },
          opts: { type: "array", items: { type: "string" } },
          ans: { type: "integer" },
          exp: { type: "string" },
          optExp: { type: "array", items: { type: "string" } },
        },
        required: ["q", "opts", "ans", "exp", "optExp"],
      },
    },
  },
  required: ["questions"],
};

/**
 * The client speaks Anthropic content blocks and will keep doing so.
 *
 * Translating here rather than changing the wire format means the app and this
 * endpoint never have to deploy together, and the next provider is another
 * function in this file rather than a change in two repositories.
 */
function toGeminiInput(userContent) {
  return userContent.map(block => {
    if (block?.type === "text") return { type: "text", text: block.text };

    const src = block?.source;
    if (src?.type === "base64" && src.data) {
      return {
        type: block.type === "image" ? "image" : "document",
        data: src.data,
        mime_type: src.media_type,
      };
    }
    return null;
  }).filter(Boolean);
}

/** Pulls the text out of a response, whichever shape the API returned it in. */
function geminiText(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;

  // Interactions API: walk the steps for text blocks.
  const fromSteps = (data?.steps || [])
    .flatMap(s => s?.content || s?.parts || [])
    .map(c => c?.text)
    .filter(Boolean)
    .join("");
  if (fromSteps) return fromSteps;

  // Classic generateContent shape, in case the endpoint is pointed back at it.
  return (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p?.text)
    .filter(Boolean)
    .join("");
}

async function callGemini({ apiKey, userContent, n, diffDesc }) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const r = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      system_instruction: systemPrompt(n, diffDesc),
      input: toGeminiInput(userContent),
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: QUESTION_SCHEMA,
      },
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, message: err?.error?.message };
  }

  return { ok: true, text: geminiText(await r.json()) };
}

/**
 * One retry on an upstream 429.
 *
 * The free tier allows ten requests a minute across every user of the app, so
 * the limit is hit in bursts — a lecture ends and several people upload at
 * once — rather than by sustained volume. A single short wait converts most of
 * those collisions into a slightly slower generation instead of an error. Only
 * one retry, and a short one: this runs inside a serverless invocation that has
 * its own timeout, and the generation itself already takes seconds.
 */
async function callGeminiWithRetry(args) {
  const first = await callGemini(args);
  if (first.ok || first.status !== 429) return first;

  await new Promise(r => setTimeout(r, 1500));
  return callGemini(args);
}

async function callAnthropic({ apiKey, userContent, n, diffDesc }) {
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
      system: systemPrompt(n, diffDesc),
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, message: err?.error?.message };
  }

  const data = await r.json();
  return { ok: true, text: data.content?.[0]?.text || "" };
}

/**
 * Accepts either a bare array or the schema's { questions: [...] } wrapper, and
 * tolerates markdown fences. The schema should make fences impossible, but the
 * Anthropic path has no schema and this costs three lines.
 */
function parseQuestions(text) {
  const clean = String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed;
  try { parsed = JSON.parse(clean); }
  catch { return null; }

  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list)) return null;

  // The app and the question bank both expect null at the answer index; the
  // schema asks for an empty string there because a nullable member inside a
  // typed array is the part schema subsets disagree about.
  return list.map(q => ({
    ...q,
    optExp: Array.isArray(q?.optExp)
      ? q.optExp.map((e, i) => (i === q.ans || e === "" ? null : e))
      : q?.optExp,
  }));
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

  // Whichever key is set decides the provider. Gemini wins when both are.
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !anthropicKey) {
    return json({ error: "Server is missing GEMINI_API_KEY." }, 500, origin);
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

  try {
    const result = geminiKey
      ? await callGeminiWithRetry({ apiKey: geminiKey, userContent, n, diffDesc })
      : await callAnthropic({ apiKey: anthropicKey, userContent, n, diffDesc });

    if (!result.ok) {
      // A quota error is worth naming honestly. "Something went wrong" invites
      // the user to retry immediately, which is the one thing that cannot work.
      if (result.status === 429) {
        return json(
          { error: "Everyone's generating at once right now. Give it a minute and try again." },
          429,
          origin,
        );
      }

      // Never leak upstream account details to the client. An upstream 401/403
      // is our misconfiguration, not the caller's, so it surfaces as a 500.
      const upstreamAuthFailed = result.status === 401 || result.status === 403;
      return json(
        { error: upstreamAuthFailed ? "Server API key was rejected." : result.message || `Upstream error ${result.status}` },
        upstreamAuthFailed ? 500 : result.status,
        origin,
      );
    }

    const questions = parseQuestions(result.text);
    if (!questions) {
      return json({ error: "The model returned invalid JSON. Try again." }, 502, origin);
    }

    return json({ questions }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Generation failed." }, 500, origin);
  }
}
