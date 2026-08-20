// Talking to the model, and the two things that reliably go wrong when you do:
// the far end being busy, and the reply not being the shape you asked for.

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Worth trying again: the request was fine and the far end was busy. A quota
// error clears within the minute, and an overloaded model is Google running
// short of capacity for a popular free-tier model rather than anything about
// this request.
export const TRANSIENT = new Set([429, 500, 502, 503, 504]);

async function once({ apiKey, model, system, input, schema }) {
  const r = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      system_instruction: system,
      input,
      response_format: { type: "text", mime_type: "application/json", schema },
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, message: err?.error?.message };
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
 * Up to two retries on a transient failure, backing off.
 *
 * Both failure modes are bursty rather than sustained: the free tier's
 * per-minute quota is shared across every user, so it is hit when several
 * people act at once, and model overload clears on Google's side in seconds.
 * Waiting briefly turns most of both into a slower answer instead of an error.
 *
 * Two and no more — this runs inside a serverless invocation with its own
 * timeout, and the call itself already takes seconds.
 */
export async function callGemini(args) {
  let last = await once(args);

  for (const wait of [1200, 2500]) {
    if (last.ok || !TRANSIENT.has(last.status)) return last;
    await new Promise(r => setTimeout(r, wait));
    last = await once(args);
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
  if (result.status === 429) {
    return json({ error: `Everyone's ${doing} at once right now. Give it a minute and try again.` }, 429, origin);
  }
  if (TRANSIENT.has(result.status)) {
    return json({ error: "The model is busy at the moment. It usually clears in a minute — try again." }, 503, origin);
  }
  return json({ error: result.message || `Upstream error ${result.status}` }, result.status, origin);
}
