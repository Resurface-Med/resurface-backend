import { describe, expect, it } from "vitest";
import { alphabetise } from "../lib/prompt.js";

describe("alphabetise with four reasons", () => {
  it("puts the answer's empty slot back so each reason stays with its option", () => {
    const q = { q: "?", opts: ["Zinc", "Copper", "Iron", "Boron", "Argon"], ans: 2,
      optExp: ["why zinc", "why copper", "why boron", "why argon"] };
    const out = alphabetise(q, false);
    expect(out.opts).toEqual(["Argon", "Boron", "Copper", "Iron", "Zinc"]);
    expect(out.opts[out.ans]).toBe("Iron");
    expect(out.optExp).toEqual(["why argon", "why boron", "why copper", "", "why zinc"]);
  });
  it("leaves five reasons as before", () => {
    const q = { q: "?", opts: ["B", "A", "C", "D", "E"], ans: 0, optExp: ["", "a", "c", "d", "e"] };
    expect(alphabetise(q, false).optExp).toEqual(["a", "", "c", "d", "e"]);
  });
});
