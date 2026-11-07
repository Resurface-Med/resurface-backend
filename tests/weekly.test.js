import { describe, expect, it } from "vitest";
import { fallbackNote, forModel, keyFigures, render, subject, text } from "../lib/weekly.js";

const week = {
  week: { from: "2026-10-26", to: "2026-11-01" }, signups: 30, signups_prev: 7, signups_studied: 22,
  weekly_active: 32, weekly_active_prev: 15, retained_from_last_week: 12, students_4plus_days: 11,
  stickiness_dau_over_wau_pct: 40, accounts_total: 80,
  weekly_active_last_8_weeks_oldest_first: [0, 0, 0, 9, 15, 32],
};

describe("weekly email", () => {
  it("drops the empty weeks before tracking began", () => {
    expect(forModel(week).weekly_active_last_8_weeks_oldest_first).toEqual([9, 15, 32]);
  });
  it("shows the business figures, not student scores", () => {
    const f = Object.fromEntries(keyFigures(week));
    expect(f["Students this week"]).toBe("32 (+113%)");
    expect(f["Sign-ups who started studying"]).toBe("73%");
    expect(f["Last week's students who came back"]).toBe("80%");
    expect(JSON.stringify(keyFigures(week))).not.toMatch(/ccuracy/);
  });
  it("renders the note escaped, with a working fallback", () => {
    const note = { headline: "Growth <doubled>", main: "m", growth: "g", sticking: "s", watch: "", next: ["Do a"], by: "x" };
    const html = render(week, note);
    expect(html).toContain("Growth &lt;doubled&gt;");
    expect(html).toContain("What to do this week");
    expect(html).not.toContain("Worth watching");
    expect(subject(week, note)).toBe("Resurface this week: Growth <doubled>");
    expect(text(week, note)).toContain("1. Do a");
    const fb = fallbackNote(week);
    expect(fb.headline).toMatch(/32 students/);
    expect(render(week, fb)).toContain("could not be generated");
  });
});
