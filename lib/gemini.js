// Talking to the model, and the two things that reliably go wrong when you do:
// the far end being busy, and the reply not being the shape you asked for.

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Worth trying again: the request was fine and the far end was busy. A quota
// error clears within the minute, and an overloaded model is Google running
// short of capacity for a popular free-tier model rather than anything about
// this request.
export const TRANSIENT = new Set([429, 500, 502, 503, 504]);

async function once({ apiKey, model, system, input, schema, maxOutputTokens, thinkingLevel, timeoutMs = 25000 }) {
  const payload = { model, system_instruction: system, input };
  if (schema) {
    payload.response_format = { type: "text", mime_type: "application/json", schema };
  }

  // Interactions puts thinking_level flat on generation_config (not nested
  // thinking_config). Gemini 3.x defaults to medium/high thinking when this is
  // omitted — fine for generating a lecture of MCQs, lethal for a mid-quiz
  // one-liner that should land in under a second.
  const gen = {};
  if (maxOutputTokens) gen.max_output_tokens = maxOutputTokens;
  if (thinkingLevel) gen.thinking_level = thinkingLevel;
  if (Object.keys(gen).length) payload.generation_config = gen;

  // Per-attempt deadline. Without one, a single upstream call that hangs
  // consumes the whole function budget and none of the retries below ever run
  // — the request fails after the platform kills it, which looks to the caller
  // exactly like the thing the retries exist to prevent.
  let r;
  try {
    r = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // A timeout or a dropped connection is transient in the same way a 503 is.
    return { ok: false, status: 504, message: e?.message, retryAfterMs: null };
  }

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    // Google says when to come back on a quota error. Guessing is strictly
    // worse than being told.
    // Optional: a Response always carries headers, but a stub or a proxy may
    // not, and reading the hint is never worth throwing over.
    const ra = Number(r.headers?.get("retry-after"));
    return {
      ok: false,
      status: r.status,
      message: err?.error?.message,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null,
    };
  }
  return { ok: true, text: extractText(await r.json()) };
}

/** Pulls the text out of a response, whichever shape the API returned it in. */
function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;

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

/**
 * Retries on a transient failure, backing off.
 *
 * Both failure modes are bursty rather than sustained: Flash-Lite allows 15
 * requests a minute across the whole free key, so it is hit when several
 * people generate at once, and model overload clears on Google's side in
 * seconds. Waiting turns most of both into a slower answer instead of an
 * error.
 *
 * Three waits on the slow path rather than two, now the routes set their own
 * maxDuration and there is budget to spend. A student who waited twelve
 * seconds for questions got questions; one who waited four and got a red box
 * has to start again anyway.
 *
 * The waits are jittered, and that matters more than their length. The failure
 * being retried is several people colliding on one shared per-minute quota —
 * a fixed backoff sends every one of them back at the same instant to collide
 * again, so the retry reproduces the exact condition it is recovering from.
 *
 * `fast: true` is for mid-quiz tutor replies: one short retry only. Sitting
 * through seconds of sleep while the student stares at "Thinking…" is worse
 * than a clean fail-and-retry.
 */
export async function callGemini(args) {
  const waits = args.fast ? [400] : [900, 2200, 4500];
  const timeoutMs = args.fast ? 12000 : 25000;

  let last = await once({ ...args, timeoutMs });

  for (const base of waits) {
    if (last.ok || !TRANSIENT.has(last.status)) return last;

    // Honour Retry-After when Google sends one, capped so a long value cannot
    // outlast the function and turn a recoverable wait into a hard timeout.
    const advised = last.retryAfterMs ? Math.min(last.retryAfterMs, 6000) : null;
    const wait = advised ?? Math.round(base * (0.7 + Math.random() * 0.6));

    await new Promise(r => setTimeout(r, wait));
    last = await once({ ...args, timeoutMs });
  }
  return last;
}

/** Tolerates markdown fences, which the schema should make impossible anyway. */
export function parseJson(text) {
  const clean = String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try { return JSON.parse(clean); }
  catch { return null; }
}

/**
 * Turns an upstream failure into something safe to show a person.
 *
 * Never echo the provider's message for an auth or quota problem: one leaks
 * account details and the other named Google's internal model in a student's
 * error box. Both are ours to explain, not theirs to read.
 */
export function upstreamError(result, origin, json, doing = "using this") {
  if (result.status === 401 || result.status === 403) {
    return json({ error: "Server API key was rejected." }, 500, origin);
  }
  // Both of these are now reached only after several attempts over ten-odd
  // seconds, so neither should ask for a retry as though it were the first
  // thing anyone tried.
  if (result.status === 429) {
    return json({ error: `Everyone's ${doing} at once. Give it a minute.` }, 429, origin);
  }
  if (TRANSIENT.has(result.status)) {
    return json({ error: "Tried a few times and it is still busy. Give it a minute." }, 503, origin);
  }
  return json({ error: result.message || `Upstream error ${result.status}` }, result.status, origin);
}
