import { describe, expect, it } from "vitest";
import { dropRepeats, isRepeat, shape } from "../lib/dedupe.js";

const q = (stem, answer, others = ["A1", "B1", "C1", "D1"]) => ({ q: stem, opts: [answer, ...others], ans: 0 });

describe("dropRepeats", () => {
  it("drops the same question asked again", () => {
    const existing = [{ q: "What is the approximate length of the adult female urethra?", a: "4 cm" }];
    const { kept, removed } = dropRepeats([q("What is the approximate length of the adult female urethra?", "4 cm")], existing);
    expect(removed).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("drops a rewording that keeps the fact (Rafil's deck, 2026-10-16)", () => {
    const existing = [{ q: "Which part of the male urethra is entirely surrounded by the prostate?", a: "Prostatic urethra" }];
    const { removed } = dropRepeats([q("Which part of the male urethra is located entirely within the prostate gland?", "Prostatic urethra")], existing);
    expect(removed).toBe(1);
  });

  it("keeps a different question about the same structure", () => {
    const existing = [{ q: "Which part of the male urethra is entirely surrounded by the prostate?", a: "Prostatic urethra" }];
    const { kept } = dropRepeats([q("Which nerve provides somatic motor innervation to the external urethral sphincter?", "Pudendal nerve")], existing);
    expect(kept).toHaveLength(1);
  });

  it("keeps a question that shares an answer but asks something else", () => {
    const existing = [{ q: "Which nerve supplies the external urethral sphincter?", a: "Pudendal nerve" }];
    const { kept } = dropRepeats([q("A 30-year-old woman has perineal numbness after a prolonged second stage of labour. Which nerve is most likely injured?", "Pudendal nerve")], existing);
    expect(kept).toHaveLength(1);
  });

  it("keeps a different question on the same topic with a different answer", () => {
    const existing = [{ q: "At approximately what mean age does end-stage renal failure typically occur in patients with autosomal dominant polycystic kidney disease?", a: "50 years" }];
    const { kept } = dropRepeats([q("What is the appropriate management for a patient with autosomal dominant polycystic kidney disease who progresses to end-stage renal failure?", "Dialysis or renal transplant")], existing);
    expect(kept).toHaveLength(1);
  });

  it("drops repeats within the same batch, keeping the first", () => {
    const a = q("What type of epithelium lines the bladder?", "Transitional epithelium");
    const b = q("What type of epithelium lines the urinary bladder mucosa?", "Transitional epithelium");
    const { kept, removed } = dropRepeats([a, b]);
    expect(kept).toEqual([a]);
    expect(removed).toBe(1);
  });

  it("works from stems alone, as older clients send them", () => {
    const { removed } = dropRepeats([q("What is the approximate length of the adult female urethra?", "4 cm")], [{ q: "What is the approximate length of the adult female urethra?" }]);
    expect(removed).toBe(1);
  });

  it("leaves a batch with nothing to compare against alone", () => {
    const qs = [q("Where is the trigone?", "Bladder base"), q("What forms the detrusor?", "Smooth muscle")];
    expect(dropRepeats(qs).kept).toEqual(qs);
  });
});

describe("isRepeat", () => {
  it("does not match two empty stems", () => {
    expect(isRepeat(shape("", ""), shape("", ""))).toBe(false);
  });
});
