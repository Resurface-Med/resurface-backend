import { describe, expect, it } from "vitest";
import { change, flags, render, subject, text } from "../lib/weekly.js";

const week = {
  from: "2026-10-26", to: "2026-11-01", signups: 30, signups_prev: 7, signups_answered: 22,
  active: 35, active_prev: 18, answers: 8150, answers_prev: 2555, returned: 15, accuracy: 77,
  busiest_day: { day: "Sunday", answers: 1346 }, top_users_answers: [1929, 981],
  decks: [{ deck: "Principles", n: 3957, people: 19, accuracy: 76, featured: true }, { deck: "<b>x</b>", n: 1, people: 1, accuracy: 100 }],
  reports: 0, reports_open: 0, shares: 2, ai_calls: { explain: 94 }, reminders_on: 4,
  longest_streak: 28, users_total: 83, keepalive_age_hours: 10,
};

describe("weekly email", () => {
  it("describes change against last week", () => {
    expect(change(35, 18)).toBe("+17 (94%) on last week");
    expect(change(10, 20)).toBe("−10 (50%) on last week");
    expect(change(5, 5)).toBe("same as last week");
    expect(change(3, 0)).toBe("+3 on last week");
  });
  it("flags nothing in a good week, and the real problems in a bad one", () => {
    expect(flags(week)).toEqual([]);
    const bad = flags({ ...week, active: 10, keepalive_age_hours: 50, reports: 2, reports_open: 5 });
    expect(bad[0]).toMatch(/keep-alive/);
    expect(bad.join(" ")).toMatch(/fell by more than a quarter/);
    expect(bad.join(" ")).toMatch(/2 question reports/);
  });
  it("renders a subject, escaped HTML and a text version", () => {
    expect(subject(week)).toBe("Resurface weekly · 26 Oct – 1 Nov");
    const html = render(week);
    expect(html).toContain("Your week at Resurface");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(text(week)).toContain("Weekly active users: 35");
  });
});
