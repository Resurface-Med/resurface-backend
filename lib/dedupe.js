/**
 * Throwing out repeats the model writes anyway.
 *
 * The prompt is told what is already in the deck (see avoidBlock in
 * prompt.js) and Flash-Lite still sometimes asks the same thing again —
 * Rafil's Lower Renal Tract deck, 2026-10-16: "What is the approximate length
 * of the adult female urethra?" a second time, and "Which part of the male
 * urethra is located entirely within the prostate?" a day after "…is
 * entirely surrounded by the prostate?". Asking more firmly is not a
 * guarantee, so this is: after generation, anything that repeats a question
 * already in the deck, or another in the same batch, is dropped.
 *
 * Two questions are the same when their stems share most of their words, or
 * share a fair part of them and have the same correct answer — the second is
 * the rewording that keeps the fact ("surrounded by" / "located within"). The
 * words compared are the ones that carry meaning: lower-cased, punctuation
 * gone, short and common words dropped, plurals folded.
 */
const STOP = new Set(`
  the and for with from that this which what when where who whom whose why how
  are was were is be been being has have had does did do not into onto than then
  its it their there these those such also most more less least very only
  following best likely main primary usually typically approximately approximate
  patient patients year old man woman presents presenting describes describe
  statement statements correct true regarding about between within
`.split(/\s+/).filter(Boolean));

export const SAME_STEM = 0.6;        // share this much of their words: a repeat
export const SAME_FACT = 0.3;        // …or this much, with the same answer
export const NEW_ANSWER = 0.85;      // different answers: only near-identical wording

export function words(text) {
  return new Set(String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(w => w.length > 2 && !STOP.has(w))
    .map(w => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const answerKey = a => String(a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** { stem, answer } → the comparable form. */
export function shape(stem, answer) {
  return { w: words(stem), a: answerKey(answer) };
}

export function isRepeat(x, y) {
  const o = overlap(x.w, y.w);
  /* A different correct answer usually means a different question about
     the same thing — "mean age of renal failure in ADPKD" against "managing
     ADPKD once it reaches renal failure" share most of their words. */
  if (x.a && y.a) return x.a === y.a ? o >= SAME_FACT : o >= NEW_ANSWER;
  return o >= SAME_STEM;
}

/**
 * questions: as returned to the client ({ q, opts, ans, … }).
 * existing:  [{ q, a }] — what the deck already holds (a may be missing).
 * Returns { kept, removed }, kept in the order written.
 */
export function dropRepeats(questions, existing = []) {
  const seen = existing.map(e => shape(e.q, e.a));
  const kept = [];
  let removed = 0;
  for (const q of questions) {
    const s = shape(q?.q, Array.isArray(q?.opts) ? q.opts[q.ans] : null);
    if (seen.some(t => isRepeat(s, t))) { removed += 1; continue; }
    seen.push(s);
    kept.push(q);
  }
  return { kept, removed };
}
