import { describe, expect, it } from "vitest";
import { CAMPAIGNS, render, text } from "../lib/campaign.js";

describe("mailing list emails", () => {
  it("has an email for each group, none of them personal", () => {
    for (const g of ["regular", "nudge", "never"]) {
      const e = CAMPAIGNS.intro[g];
      expect(e.subject).toBeTruthy();
      const html = render(e, "https://api.tryresurface.com/api/unsubscribe?u=x&t=y");
      expect(html).toContain("Hey,");
      expect(html).toContain("Unsubscribe");
      expect(html).toContain("u=x&amp;t=y");
      expect(text(e, "U")).toContain("Unsubscribe: U");
    }
  });
  it("puts the button where it is asked for", () => {
    const html = render(CAMPAIGNS.intro.never, "u");
    expect(html.indexOf("Do 10 questions")).toBeGreaterThan(html.indexOf("About five minutes"));
    expect(html.indexOf("Do 10 questions")).toBeLessThan(html.indexOf("It's free"));
    expect(text(CAMPAIGNS.intro.never, "u")).toContain("Do 10 questions: https://app.tryresurface.com");
  });
  it("uses the old-fashioned line, not slides", () => {
    expect(JSON.stringify(CAMPAIGNS)).toContain("old-fashioned way");
    expect(JSON.stringify(CAMPAIGNS)).not.toMatch(/from slides/);
  });
});

