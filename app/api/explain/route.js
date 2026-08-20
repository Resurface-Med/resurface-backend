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
Be concrete: name the mechanism, the structure, the value. Do not be encouraging or apologetic. No preamble.`;

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

  const { question, options, correct, picked, explanation } = body || {};
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

  // The whole point: the model is told what they picked. Without it this is
  // just the same explanation again in different words.
  const chose = Number.isInteger(pi) && options[pi]
    ? `They chose: ${options[pi]}`
    : "They did not answer in time.";

  const input = [{
    type: "text",
    text: [
      `Question: ${question}`,
      `Options: ${options.map((o, i) => `${"ABCDE"[i]}. ${o}`).join(" | ")}`,
      `Correct answer: ${options[ci]}`,
      chose,
      explanation ? `The explanation they already read: ${explanation}` : null,
    ].filter(Boolean).join("\n"),
  }];

  try {
    const result = await callGemini({
      apiKey,
      model: process.env.GEMINI_EXPLAIN_MODEL || DEFAULT_MODEL,
      system: SYSTEM,
      input,
      schema: SCHEMA,
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
