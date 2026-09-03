// A second explanation, for when the first one did not land.
//
// The bank's explanation says why the right answer is right. Someone who picked
// a wrong one has a specific belief that led them there, and the fixed text
// does not know what it was. This does: it is told which option they chose, so
// it can address that misconception rather than restating the answer louder.
//
// It runs on its own API key when one is set. That is isolation rather than
// thrift — asking why you were wrong is cheap and frequent, generating a
// lecture's worth of questions is neither, and a burst of one should not leave
// the other with nothing.

import { allowedOrigin, json, preflight, rateLimited, verify } from "../../../lib/http.js";
import { callGemini, parseJson, upstreamError } from "../../../lib/gemini.js";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// Higher than generation's ten. This costs a fraction as much and is asked
// mid-session, often twice in a row on the same question.
const MAX_PER_WINDOW = 20;

const SYSTEM = `You are helping a Year 1 medical student who has just answered a multiple-choice question incorrectly.
They chose one option. Explain, in plain English, why the thing they were probably thinking is wrong, then why the correct answer is right.
Address the specific confusion their choice implies — do not simply restate the model answer.
Be concrete: name the mechanism, the structure, the value. Teach enough that they would get the next one right — a short paragraph per field is fine; a slogan is not.
Do not be encouraging or apologetic. No preamble. Do not recap the stem.
Write chemistry and maths in plain Unicode (ΔG, Na⁺, Ca²⁺, →). Never LaTeX, never $…$, never markdown.`;

const SCHEMA = {
  type: "object",
  properties: {
    // Their mistake first. Someone who has just got it wrong wants to know
    // what they were thinking before they want to be told the answer again.
    why_wrong: { type: "string" },
    why_right: { type: "string" },
    // One line worth carrying into the exam.
    remember: { type: "string" },
  },
  required: ["why_wrong", "why_right", "remember"],
};

export async function OPTIONS(req) {
  return preflight(req);
}

export async function POST(req) {
  const origin = allowedOrigin(req.headers.get("origin"));

  const user = await verify(req);
  if (!user) return json({ error: "Sign in first." }, 401, origin);

  // Its own key when there is one, so the two features have separate quotas
  // and a busy afternoon of generating does not silence this.
  const apiKey = process.env.GEMINI_EXPLAIN_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "Server is missing GEMINI_API_KEY." }, 500, origin);

  if (rateLimited("explain", user.id, MAX_PER_WINDOW)) {
    return json({ error: "Slow down a moment, then try again." }, 429, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Malformed request body." }, 400, origin); }

  const { question, options, correct, picked, explanation, message, history } = body || {};
  if (typeof question !== "string" || !Array.isArray(options) || options.length === 0) {
    return json({ error: "Nothing to explain." }, 400, origin);
  }

  // Number(null) is 0, so coercing without checking first would report a
  // timed-out question as though the student had picked option A — and then
  // explain a mistake they never made.
  const ci = Number(correct);
  const pi = picked === null || picked === undefined ? NaN : Number(picked);
  if (!Number.isInteger(ci) || !options[ci]) {
    return json({ error: "Nothing to explain." }, 400, origin);
  }

  const ctx = buildContext(
    { question, options, correct: ci, picked: pi, explanation },
    { compact: typeof message === "string" && Boolean(message.trim()) },
  );

  if (typeof message === "string" && message.trim()) {
    return followUp({ origin, apiKey, ctx, message: message.trim(), history });
  }

  const input = [{ type: "text", text: ctx }];

  try {
    const result = await callGemini({
      apiKey,
      model: process.env.GEMINI_EXPLAIN_MODEL || DEFAULT_MODEL,
      system: SYSTEM,
      input,
      schema: SCHEMA,
      maxOutputTokens: 280,
      thinkingLevel: "minimal",
      fast: true,
    });

    if (!result.ok) return upstreamError(result, origin, json, "asking for help");

    const parsed = parseJson(result.text);
    if (!parsed?.why_right) {
      return json({ error: "Couldn't put that into words. Try again." }, 502, origin);
    }

    return json({
      whyWrong: parsed.why_wrong || "",
      whyRight: parsed.why_right,
      remember: parsed.remember || "",
    }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Explanation failed." }, 500, origin);
  }
}

function buildContext({ question, options, correct, picked, explanation }, { compact = false } = {}) {
  const chose = Number.isInteger(picked) && options[picked]
    ? `They chose: ${options[picked]}`
    : "They did not answer in time.";

  return [
    `Question: ${question}`,
    `Options: ${options.map((o, i) => `${"ABCDE"[i]}. ${o}`).join(" | ")}`,
    `Correct answer: ${options[correct]}`,
    chose,
    // Follow-ups already sit next to the bank explanation on screen — repeating
    // it here just burns tokens and time for no new information.
    !compact && explanation ? `The explanation they already read: ${explanation}` : null,
  ].filter(Boolean).join("\n");
}

const FOLLOW_UP_SYSTEM = `You are Resurface AI — a quick tutor mid-quiz, not a textbook.
The student already sees the question, their wrong pick, and the official explanation. Never repeat the stem, list all options, or restate what they already read.

Answer ONLY what they asked. Stay on this one fact — no adjacent topics, no "also remember", no pathophysiology tangents unless they explicitly asked.

Length:
- Default: 2–3 short sentences, under 60 words.
- If they asked for one line: one sentence only.
- If they asked why they were wrong: 1–2 sentences naming the single confusion.

Simple words. One point. No preamble, no encouragement, no bullet lists.
Plain Unicode for chemistry (ΔG, Na⁺, →). Never LaTeX, markdown, or $…$.`;

async function followUp({ origin, apiKey, ctx, message, history }) {
  if (message.length > 500) {
    return json({ error: "Keep follow-ups under 500 characters." }, 400, origin);
  }

  const turns = Array.isArray(history) ? history.slice(-4) : [];
  const transcript = turns
    .filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
    .map(t => `${t.role === "user" ? "Student" : "Tutor"}: ${t.text.trim()}`)
    .join("\n\n");

  const input = [{
    type: "text",
    text: [
      ctx,
      transcript ? `Conversation so far:\n${transcript}` : null,
      `Student follow-up: ${message}`,
    ].filter(Boolean).join("\n\n"),
  }];

  try {
    const result = await callGemini({
      apiKey,
      model: process.env.GEMINI_EXPLAIN_MODEL || DEFAULT_MODEL,
      system: FOLLOW_UP_SYSTEM,
      input,
      maxOutputTokens: 120,
      thinkingLevel: "minimal",
      fast: true,
    });

    if (!result.ok) return upstreamError(result, origin, json, "asking for help");

    const reply = String(result.text || "").trim();
    if (!reply) {
      return json({ error: "Couldn't put that into words. Try again." }, 502, origin);
    }

    return json({ reply }, 200, origin);
  } catch (e) {
    return json({ error: e.message || "Explanation failed." }, 500, origin);
  }
}
