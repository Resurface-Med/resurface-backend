import { describe, expect, it } from "vitest";
import { EXEMPLARS } from "../lib/prompt.js";
import { answerInStem, dropGiveaways } from "../lib/giveaway.js";

const q = (stem, answer, others = ["Aa", "Bb", "Cc", "Dd"]) => ({
  q: stem, opts: [answer, ...others], ans: 0,
});

describe("answerInStem", () => {
  it("drops a stem that names the correct option and then asks for it", () => {
    expect(answerInStem(q(
      "tRNA carries amino acids to the ribosome. Which form of RNA does this?",
      "tRNA",
    ))).toBe(true);
    expect(answerInStem(q(
      "Paracrine signalling describes gastrin acting on nearby cells. What kind of signalling is this?",
      "Paracrine",
    ))).toBe(true);
    expect(answerInStem(q(
      "Schistosomiasis causes squamous cell carcinoma of the bladder. What histological type of cancer is this?",
      "Squamous cell carcinoma",
    ))).toBe(true);
  });

  it("keeps a stem that mentions the subject without stating the answer", () => {
    expect(answerInStem(q(
      "Which form of RNA brings amino acids to the protein synthesis apparatus within a cell?",
      "tRNA",
    ))).toBe(false);
    expect(answerInStem(q(
      "A 50 year old man has end-stage renal failure. At what mean age does this typically occur in ADPKD?",
      "50 years",
    ))).toBe(false);
    expect(answerInStem(q(
      "A tumour confined to the urothelium is which stage?",
      "Ta",
    ))).toBe(false);
  });

  it("leaves the university paper's own questions alone", () => {
    for (const exemplar of EXEMPLARS) expect(answerInStem(exemplar)).toBe(false);
  });
});

describe("dropGiveaways", () => {
  it("keeps the rest of the batch in order", () => {
    const good = q("Which cells respond first to an acute bacterial infection?", "Neutrophils");
    const bad = q("Neutrophils respond first to bacterial infection. Which cells are these?", "Neutrophils");
    const { kept, removed } = dropGiveaways([bad, good]);
    expect(removed).toBe(1);
    expect(kept).toEqual([good]);
  });
});
