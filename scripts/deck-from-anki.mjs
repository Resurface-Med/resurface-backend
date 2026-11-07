// Questions for a ready-made deck from an Anki export, lecture by lecture,
// with exactly what the app's Generate button uses: the same Gemini model,
// system prompt, schema, alphabetising and giveaway filter. The cards are
// the only material; nothing outside them is given to the model.
//
//   node scripts/deck-from-anki.mjs <lectures.json> <out-dir> [--only=name]
//
// lectures.json: [{ path: ["Medicine", "Gout"], cards: [{ Front, Back }] }]
// Writes <out-dir>/<n>.json per lecture: { path, cards, questions }.
// Skips lectures already written, so it can be stopped and resumed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini, parseJson } from "../lib/gemini.js";
import { systemPrompt, QUESTION_SCHEMA, alphabetise } from "../lib/prompt.js";
import { dropGiveaways } from "../lib/giveaway.js";
import { dropRepeats } from "../lib/dedupe.js";

const [, , inFile, outDir, ...flags] = process.argv;
const only = flags.find(f => f.startsWith("--only="))?.slice(7);
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const apiKey = env.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!apiKey) throw new Error("No GEMINI_API_KEY in .env.local");
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
mkdirSync(outDir, { recursive: true });

const lectures = JSON.parse(readFileSync(inFile, "utf8"));

/** About one and a half questions per card, as the GI deck has. */
const howMany = cards => Math.min(50, Math.max(5, Math.round(cards * 1.5)));

function material(l) {
  const lines = l.cards.map((c, i) => {
    const front = c.Front ?? c.FrontText ?? Object.values(c)[0] ?? "";
    const back = c.Back ?? c.BackText ?? Object.values(c)[1] ?? "";
    return `Card ${i + 1}\nFront: ${front}\nBack: ${back}`;
  });
  return `Lecture: ${l.path.join(" — ")}\n\nThe material is these flashcards, in full. Write only from them.\n\n${lines.join("\n\n")}`;
}

function parseQuestions(text) {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list)) return null;
  return list.map(q => {
    const optExp = Array.isArray(q?.optExp) ? q.optExp.map((e, i) => (i === q.ans || e === "" ? null : e)) : q?.optExp;
    const { ordered, ...rest } = q ?? {};
    return alphabetise({ ...rest, optExp }, ordered);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function one(l, idx) {
  const file = join(outDir, `${String(idx).padStart(3, "0")}.json`);
  if (existsSync(file)) return "skip";
  const n = howMany(l.cards.length);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = Date.now();
    const r = await callGemini({
      apiKey, model, system: systemPrompt(n), schema: QUESTION_SCHEMA, timeoutMs: 120_000,
      input: [{ type: "text", text: material(l) }],
    });
    if (r.ok) {
      const parsed = parseQuestions(r.text);
      if (parsed) {
        const fresh = dropGiveaways(parsed);
        const { kept } = dropRepeats(fresh.kept, []);
        writeFileSync(file, JSON.stringify({ path: l.path, cards: l.cards, asked: n, questions: kept }, null, 1));
        console.log(`${idx} ${l.path.join(" / ")}: ${kept.length}/${n} in ${Date.now() - started} ms`);
        return "ok";
      }
    }
    console.log(`${idx} ${l.path.join(" / ")}: attempt ${attempt} failed (${r.status ?? "bad JSON"})`);
    await sleep(5000 * attempt);
  }
  return "fail";
}

const todo = lectures.map((l, i) => [l, i]).filter(([l]) => !only || l.path.join("/").includes(only));
let next = 0;
const results = [];
async function worker() {
  while (next < todo.length) {
    const [l, i] = todo[next++];
    results.push(await one(l, i));
  }
}
await Promise.all([worker(), worker()]);
console.log("done", Object.fromEntries(["ok", "skip", "fail"].map(k => [k, results.filter(x => x === k).length])));
