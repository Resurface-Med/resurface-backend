import { allowedOrigin, json, preflight, rateLimited, verify } from "../../../lib/http.js";
import { callGemini, parseJson, upstreamError } from "../../../lib/gemini.js";

const MAX_COUNT = 20;
const MAX_PER_WINDOW = 10;

// Flash-Lite, and the free tier's shape is the reason rather than the model's.
// Every full Flash model — 3, 3.5, 3.6, 3.7 — is capped at 20 requests a day
// on a free key, which across a hundred users is one lecture each per five
// days. Flash-Lite gets 500 a day and 15 a minute for the same nothing.
//
// The newest models are also the most contended on the free tier: 3.7 Flash
// returned "experiencing high demand" while Flash-Lite was answering normally
// in the same minutes. Fewer people queue for the smaller model.
//
// If billing is ever switched on, GEMINI_MODEL=gemini-3.7-flash: the quota
// stops mattering, paid keys are not queued behind the free tier, and it costs
// about $0.02 a lecture.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const DIFF_DESC = {
  easy:   "direct single-fact recall (where/what/which enzyme)",
  medium: "mechanism/application (why does X, what happens if Y inhibited)",
  hard:   "clinical vignette — every question must open with a patient scenario",
};

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
  const parsed = parseJson(text);
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
  return preflight(req);
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

  if (rateLimited("generate", user.id, MAX_PER_WINDOW)) {
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
      ? await callGemini({
          apiKey: geminiKey,
          model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
          system: systemPrompt(n, diffDesc),
          input: toGeminiInput(userContent),
          schema: QUESTION_SCHEMA,
        })
      : await callAnthropic({ apiKey: anthropicKey, userContent, n, diffDesc });

    if (!result.ok) return upstreamError(result, origin, json, "generating");

    const questions = parseQuestions(result.text);
    if (!questions) {
      return json({ error: "The model returned invalid JSON. Try again." }, 502, origin);
    }

    return json({ questions }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Generation failed." }, 500, origin);
  }
}
