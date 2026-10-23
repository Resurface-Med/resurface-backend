import { describe, it, expect } from "vitest";
import { alphabetise } from "../lib/prompt.js";

const q = (opts, ans) => ({ q: "?", opts, ans, exp: "", optExp: opts.map((o, i) => (i === ans ? null : `not ${o}`)) });

describe("alphabetise", () => {
  it("sorts words alphabetically and keeps the answer and its explanations aligned", () => {
    const r = alphabetise(q(["Tibia", "Femur", "Sternum", "Radius", "Humerus"], 2));
    expect(r.opts).toEqual(["Femur", "Humerus", "Radius", "Sternum", "Tibia"]);
    expect(r.opts[r.ans]).toBe("Sternum");
    expect(r.optExp[r.ans]).toBeNull();
    expect(r.optExp[0]).toBe("not Femur");
  });

  it("sorts numbers as numbers, not as text", () => {
    const r = alphabetise(q(["10%", "1%", "50%", "5%", "20%"], 3));
    expect(r.opts).toEqual(["1%", "5%", "10%", "20%", "50%"]);
    expect(r.opts[r.ans]).toBe("5%");
  });

  it("handles negatives, decimals and thousands separators", () => {
    expect(alphabetise(q(["-3.1 kcal/mol", "-12.0 kcal/mol", "-7.3 kcal/mol", "-5.0 kcal/mol", "-10.5 kcal/mol"], 2)).opts)
      .toEqual(["-12.0 kcal/mol", "-10.5 kcal/mol", "-7.3 kcal/mol", "-5.0 kcal/mol", "-3.1 kcal/mol"]);
    expect(alphabetise(q(["96,500", "8.3", "310", "0.02567", "-2.303"], 0)).opts)
      .toEqual(["-2.303", "0.02567", "8.3", "310", "96,500"]);
  });

  it("sorts ranges by where they start", () => {
    expect(alphabetise(q(["90–98 °C", "4 °C", "50–65 °C", "20–37 °C", "70–75 °C"], 2)).opts)
      .toEqual(["4 °C", "20–37 °C", "50–65 °C", "70–75 °C", "90–98 °C"]);
  });

  it("leaves mixed units alphabetical rather than ordering them by digits alone", () => {
    expect(alphabetise(q(["1 ms", "2 seconds", "500 ms", "10 seconds", "50 ms"], 0)).opts)
      .toEqual(["1 ms", "10 seconds", "2 seconds", "50 ms", "500 ms"]);
  });

  it("keeps a sequence in the order written", () => {
    const opts = ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "Preclinical"];
    expect(alphabetise(q(opts, 1), true).opts).toEqual(opts);
  });
});
