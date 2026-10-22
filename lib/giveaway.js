/**
 * The model sometimes names the answer in the stem and then asks for it.
 * The prompt forbids that. This is what makes sure one still gets dropped,
 * because asking more firmly is not a guarantee.
 *
 * The correct option has to appear as a run of whole words. A bare number
 * is left alone — "50" is the age in "a 50 year old" as often as it is an
 * answer — and so is a one- or two-letter token such as a stage code.
 */

const WORD = /[a-z0-9]+/g;

function tokens(text) {
  return String(text ?? "").toLowerCase().match(WORD) ?? [];
}

export function answerInStem(q) {
  const ans = Array.isArray(q?.opts) ? q.opts[q.ans] : null;
  const stem = tokens(q?.q);
  const key = tokens(ans);
  if (!stem.length || !key.length) return false;
  const letters = key.join("").replace(/[0-9]/g, "");
  if (letters.length < 2) return false;
  if (letters.length < 3 && key.length < 2) return false;
  for (let i = 0; i <= stem.length - key.length; i++) {
    let same = true;
    for (let j = 0; j < key.length; j++) {
      if (stem[i + j] !== key[j]) { same = false; break; }
    }
    if (same) return true;
  }
  return false;
}

/** questions as the route holds them. Returns { kept, removed }. */
export function dropGiveaways(questions) {
  const kept = [];
  let removed = 0;
  for (const q of questions ?? []) {
    if (answerInStem(q)) removed += 1;
    else kept.push(q);
  }
  return { kept, removed };
}
