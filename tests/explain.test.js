import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: (...a) => mockGetUser(...a) } }),
}));

const { POST, OPTIONS } = await import("../app/api/explain/route.js");

const ORIGIN = "https://app.tryresurface.com";

const QUESTION = {
  question: "Beta-1 receptors are coupled to:",
  options: ["Gi", "Gq", "Gs", "Nuclear receptor", "Tyrosine kinase"],
  correct: 2,
  picked: 0,
  explanation: "Beta-1 raises cAMP.",
};

function req({ token = "good-token", body = QUESTION } = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://api.test/api/explain", { method: "POST", headers, body: JSON.stringify(body) });
}

function returns(payload, ok = true, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok, status, json: async () => payload });
  return globalThis.fetch;
}

const GOOD = { why_wrong: "Gi lowers cAMP.", why_right: "Beta-1 is Gs.", remember: "Beta-1 raises cAMP." };

let userId = "u1";
beforeEach(() => {
  process.env.GEMINI_API_KEY = "gem-test";
  delete process.env.GEMINI_EXPLAIN_API_KEY;
  userId = "user-" + Math.random().toString(36).slice(2);
  mockGetUser.mockImplementation(async (t) =>
    t === "good-token"
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: new Error("bad jwt") });
});
afterEach(() => vi.restoreAllMocks());

describe("access", () => {
  it("requires a session", async () => {
    expect((await POST(req({ token: null }))).status).toBe(401);
  });

  it("answers preflight for an allowed origin", async () => {
    const res = await OPTIONS(new Request("https://api.test/api/explain", {
      method: "OPTIONS", headers: new Headers({ origin: ORIGIN }),
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("what the model is told", () => {
  it("names the option the student actually picked", async () => {
    const f = returns({ output_text: JSON.stringify(GOOD) });
    await POST(req());
    const sent = JSON.parse(f.mock.calls[0][1].body);
    // Without this the answer is just the same explanation reworded.
    expect(sent.input[0].text).toContain("They chose: Gi");
    expect(sent.input[0].text).toContain("Correct answer: Gs");
  });

  it("copes with a question that ran out of time", async () => {
    const f = returns({ output_text: JSON.stringify(GOOD) });
    await POST(req({ body: { ...QUESTION, picked: null } }));
    expect(JSON.parse(f.mock.calls[0][1].body).input[0].text).toContain("did not answer in time");
  });

  it("asks for the three parts against a schema", async () => {
    const f = returns({ output_text: JSON.stringify(GOOD) });
    await POST(req());
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(Object.keys(sent.response_format.schema.properties)).toEqual(["why_wrong", "why_right", "remember"]);
  });
});

describe("its own key", () => {
  it("prefers the explain key when one is set", async () => {
    process.env.GEMINI_EXPLAIN_API_KEY = "explain-key";
    const f = returns({ output_text: JSON.stringify(GOOD) });
    await POST(req());
    expect(f.mock.calls[0][1].headers["x-goog-api-key"]).toBe("explain-key");
  });

  it("falls back to the generation key when it is not", async () => {
    const f = returns({ output_text: JSON.stringify(GOOD) });
    await POST(req());
    expect(f.mock.calls[0][1].headers["x-goog-api-key"]).toBe("gem-test");
  });
});

describe("responses", () => {
  it("returns the three parts", async () => {
    returns({ output_text: JSON.stringify(GOOD) });
    const body = await (await POST(req())).json();
    expect(body.whyWrong).toBe("Gi lowers cAMP.");
    expect(body.whyRight).toBe("Beta-1 is Gs.");
    expect(body.remember).toBe("Beta-1 raises cAMP.");
  });

  it("rejects a body with nothing to explain", async () => {
    expect((await POST(req({ body: { question: "x" } }))).status).toBe(400);
  });

  it("does not echo a rejected key", async () => {
    returns({ error: { message: "API key not valid: AIza-secret" } }, false, 403);
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("AIza");
  });
});
