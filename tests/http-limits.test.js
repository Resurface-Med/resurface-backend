import { describe, expect, it, vi, afterEach } from "vitest";
import { rateLimited, takeQuota, heldKeys } from "../lib/http.js";

afterEach(() => vi.useRealTimers());

describe("rate limits", () => {
  it("limit within the window and forget after it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(rateLimited("t1", "a", 2)).toBe(false);
    expect(rateLimited("t1", "a", 2)).toBe(false);
    expect(rateLimited("t1", "a", 2)).toBe(true);
    vi.setSystemTime(61_000);
    expect(rateLimited("t1", "a", 2)).toBe(false);
  });
  it("a quota refusal does not use a slot", () => {
    expect(takeQuota("t2", "q", 1).allowed).toBe(true);
    expect(takeQuota("t2", "q", 1)).toMatchObject({ allowed: false, used: 1 });
    expect(takeQuota("t2", "q", 1)).toMatchObject({ allowed: false, used: 1 });
  });
  it("drops keys whose window has passed instead of keeping them for ever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 500; i++) rateLimited("t3", `user${i}`, 5, 1000);
    const before = heldKeys();
    vi.setSystemTime(1_010_000);
    for (let i = 0; i < 1000; i++) rateLimited("t4", "same", 5000, 1000);
    expect(before).toBeGreaterThanOrEqual(500);
    expect(heldKeys()).toBeLessThan(before - 400);
  });
});
