import { describe, expect, it } from "vitest";
import { EXEMPLARS } from "../lib/prompt.js";
import { dropLectureRefs, pointsAtSource } from "../lib/lectureRef.js";

describe("pointsAtSource", () => {
  it("catches stems that need the lecture in front of you", () => {
    for (const s of [
      "Name the prostaglandins mentioned in this lecture.",
      "What is the broad classification category for autoimmune diseases mentioned in the lecture?",
      "Which factor is explicitly listed in the lecture as a cause of poor bone healing?",
      "How is this sign termed in the lecture notes?",
      "What role do endothelial cells play according to the lecture notes?",
      "Which medication class is listed in the source material as a cause of a raised CK?",
      "A medical lecturer highlights a membrane at the caudal end of the hindgut. What is it called?",
      "Which drug is covered in the slides as first line?",
    ]) expect(pointsAtSource(s), s).toBe(true);
  });

  it("keeps clinical uses of the same words", () => {
    for (const s of [
      "A 45-year-old woman is listed for removal of a phaeochromocytoma. Which drug controls her blood pressure?",
      "Decreased breath sounds are noted on auscultation. What is the next step?",
      "A newborn is noted to have bilateral impalpable testes. When should he be referred?",
      "Which murmur becomes louder on deep inspiration?",
    ]) expect(pointsAtSource(s), s).toBe(false);
  });

  it("passes every exemplar in the prompt", () => {
    for (const e of EXEMPLARS ?? []) expect(pointsAtSource(e.q ?? e.stem ?? "")).toBe(false);
  });
});

describe("dropLectureRefs", () => {
  it("counts what it drops", () => {
    const r = dropLectureRefs([{ q: "Which drug is named in this lecture?" }, { q: "Which drug blocks COX-2?" }]);
    expect(r.removed).toBe(1);
    expect(r.kept).toHaveLength(1);
  });
});
