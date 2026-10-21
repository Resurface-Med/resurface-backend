import { allowedOrigin, bearer, json, logUsage, preflight, rateLimited, takeQuota, verify } from "../../../lib/http.js";
import { dropRepeats } from "../../../lib/dedupe.js";
import { callGemini, parseJson, upstreamError } from "../../../lib/gemini.js";
import { systemPrompt, QUESTION_SCHEMA, alphabetise } from "../../../lib/prompt.js";

/**
 * Set explicitly rather than left to the platform default, because the retries
 * in callGemini are only real if the function outlives them. A full set is
 * tens of seconds on its own, so the budget is two attempts of ATTEMPT_MS
 * plus the backoff between them.
 */
export const maxDuration = 120;
const ATTEMPT_MS = 55_000;

/*
 * Fifty, measured rather than inherited.
 *
 * This was twenty from the first commit with no comment, which made it look
 * like a limit someone had found. It was not: requests are what the free
 * tier counts, not questions, so a small cap wastes the scarce thing — two
 * requests to get fifty questions costs twice as much of the day as one.
 *
 * What actually bounds it, from a real generation of ten that took 6,957ms
 * and 3,370 output tokens:
 *   time   — about 0.7s a question, against ATTEMPT_MS of 55s, so the
 *            timeout arrives somewhere around seventy. Fifty is ~35s.
 *   output — about 340 tokens a question. Fifty is ~17,000. This path sets
 *            no cap of its own, so what applies is the model's, and that
 *            number is not something I have confirmed.
 *
 * So fifty is a deliberate choice rather than a safe one. The failure it
 * risks is not fewer questions: a reply cut off mid-JSON does not parse, so
 * the whole batch fails with "The model returned invalid JSON", and the
 * retry costs another request. If that ever appears at fifty and not at
 * forty, that is the reason and forty is the fallback.
 *
 * The real limit is not technical. A lecture holds only so many fair
 * questions, and the prompt is told not to ask about a passing mention — so
 * past some point this stops writing questions and starts padding. That
 * point depends on the lecture, which is why it is not enforced here.
 */
const MAX_COUNT = 50;
const MAX_PER_WINDOW = 10;

/*
 * Generations per person per day. The free Gemini tier is 500 requests a day
 * for everyone together, and batches (up to ten lectures, one request each)
 * let one person spend a lot of it quickly. Thirty is three full batches.
 * In-memory like the rest, so best-effort: a cold start forgets it.
 */
const MAX_PER_DAY = 30;

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

/* How much of a deck's existing questions to show the model. Sixty stems of
   a hundred and sixty characters is about two thousand tokens — real against
   a lecture, and cheap against generating the same questions twice. */
const AVOID_MAX = 60;
const AVOID_CHARS = 160;
/* How many of the deck's questions the result is checked against. Larger
   than AVOID_MAX: checking costs nothing, the prompt is what is paid for. */
const EXISTING_MAX = 1000;







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

async function callAnthropic({ apiKey, userContent, n, avoid }) {
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
      system: systemPrompt(n, avoid),
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
  return list.map(q => {
    const optExp = Array.isArray(q?.optExp)
      ? q.optExp.map((e, i) => (i === q.ans || e === "" ? null : e))
      : q?.optExp;
    const { ordered, ...rest } = q ?? {};
    return alphabetise({ ...rest, optExp }, ordered);
  });
}


export async function OPTIONS(req) {
  return preflight(req);
}

export async function POST(req) {
  const origin = allowedOrigin(req.headers.get("origin"));

  // A shared access code couldn't be revoked for one person and told us
  // nothing about who was calling. The session token does both: Supabase
  // verifies the signature, and we get a user id to rate limit against.
  const token = bearer(req);
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
  if (!takeQuota("generate-day", user.id, MAX_PER_DAY, 24 * 60 * 60 * 1000).allowed) {
    return json({ error: `That's ${MAX_PER_DAY} generations today, the daily limit. It resets tomorrow.` }, 429, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request body." }, 400, origin); }

  const { userContent, count = 5, avoid: rawAvoid } = body || {};
  if (!Array.isArray(userContent) || userContent.length === 0) {
    return json({ error: "No content to generate from." }, 400, origin);
  }

  const asked = Math.max(parseInt(count) || 5, 1);
  const n = Math.min(asked, MAX_COUNT);

  /*
   * The stems already in the deck, so a second pass over the same lecture
   * does not write the same questions again.
   *
   * Bounded here rather than trusted: this arrives from the client and is
   * pasted into the prompt, so it is capped at AVOID_MAX stems of
   * AVOID_CHARS each — a deck of three hundred would otherwise cost more in
   * input than the lecture does. Newest first, because the client sends
   * them in order and the recent ones are the likely collisions.
   */
  /* Each is a stem, or { q, a } — the stem and its correct answer — from
     clients since 2026-10-17: with the answer the model can see which *fact*
     was tested, not only how it was worded. All of them (bounded) are used
     to filter the result; the newest AVOID_MAX go into the prompt. */
  const clip = (x, n) => (x.length > n ? `${x.slice(0, n)}…` : x);
  const tidy = x => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const existing = (Array.isArray(rawAvoid) ? rawAvoid : [])
    .slice(-EXISTING_MAX)
    .map(x => (typeof x === "string" ? { q: tidy(x), a: "" } : { q: tidy(x?.q), a: tidy(x?.a) }))
    .filter(x => x.q);
  const avoid = existing
    .slice(-AVOID_MAX)
    .map(x => (x.a ? `${clip(x.q, AVOID_CHARS)} (answer: ${clip(x.a, 60)})` : clip(x.q, AVOID_CHARS)));
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  try {
    const input = toGeminiInput(userContent);
    const started = Date.now();
    const result = geminiKey
      ? await callGemini({
          apiKey: geminiKey,
          model,
          system: systemPrompt(n, avoid),
          input,
          schema: QUESTION_SCHEMA,
          timeoutMs: ATTEMPT_MS,
        })
      : await callAnthropic({ apiKey: anthropicKey, userContent, n, avoid });

    // One line per call so the next slow one can be read off the logs
    // rather than reasoned about.
    /* asked is logged only when it differs, so a count that does not match
       what somebody chose is visible here rather than inferred from a
       complaint. The client caps at the same number, so this firing means an
       old tab or something calling the API directly. */
    console.log(`generate n=${n}${asked !== n ? ` (asked ${asked})` : ""} avoid=${avoid.length} ${result.ok ? "ok" : result.status} ${Date.now() - started}ms`);
    if (!result.ok) return upstreamError(result, origin, json, "generating");

    // Awaited rather than left running: a serverless invocation can be torn
    // down the moment it replies, and a dropped write here would quietly
    // under-report the expensive half of the bill. Against a call that took
    // seconds, one insert costs nothing worth saving.
    await logUsage({ token, userId: user.id, kind: "generate", model, usage: result.usage });

    const parsed = parseQuestions(result.text);
    if (!parsed) {
      return json({ error: "The model returned invalid JSON. Try again." }, 502, origin);
    }

    /* The prompt asks for nothing already in the deck; this makes sure. */
    const { kept: questions, removed } = dropRepeats(parsed, existing);
    if (removed) console.log(`generate dropped ${removed} repeat${removed === 1 ? "" : "s"} of ${parsed.length}`);

    return json({ questions, removed }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Generation failed." }, 500, origin);
  }
}
