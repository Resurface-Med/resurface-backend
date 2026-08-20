import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The route resolves the bearer token through supabase-js, so the client is
// stubbed rather than reaching the network. Must be hoisted above the import.
const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: (...a) => mockGetUser(...a) } }),
}));

const { POST, OPTIONS } = await import("../app/api/generate/route.js");

// Guards the parts that protect the API key and the bill: authentication, the
// CORS allowlist, and never echoing an upstream auth failure to the client.

const ORIGIN = "https://app.resurface.example";

function req({ origin = ORIGIN, token = "good-token", body = { userContent: [{ type: "text", text: "x" }] } } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) headers.set("origin", origin);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://api.test/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function anthropicReturns(payload, ok = true, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok, status,
    json: async () => payload,
  });
}

let userId = "user-1";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_ANON_KEY = "sb_publishable_test";
  process.env.ALLOWED_ORIGINS = `${ORIGIN},http://localhost:5173`;
  userId = "user-" + Math.random().toString(36).slice(2);
  mockGetUser.mockImplementation(async (token) =>
    token === "good-token"
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: new Error("bad jwt") });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authentication", () => {
  it("rejects an invalid token", async () => {
    const res = await POST(req({ token: "forged" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sign in/i);
  });

  it("rejects a missing token", async () => {
    const res = await POST(req({ token: null }));
    expect(res.status).toBe(401);
  });

  it("accepts a valid session", async () => {
    anthropicReturns({ content: [{ text: '[{"q":"a"}]' }] });
    const res = await POST(req());
    expect(res.status).toBe(200);
  });
});

describe("CORS", () => {
  it("echoes an allowed origin", async () => {
    anthropicReturns({ content: [{ text: "[]" }] });
    const res = await POST(req());
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("sends no allow-origin for an unlisted origin", async () => {
    anthropicReturns({ content: [{ text: "[]" }] });
    const res = await POST(req({ origin: "https://evil.example" }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflight with 204 and the allowed methods", async () => {
    const res = await OPTIONS(new Request("https://api.test/api/generate", {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("request validation", () => {
  it("rejects empty content", async () => {
    const res = await POST(req({ body: { userContent: [] } }));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const res = await POST(new Request("https://api.test/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, authorization: "Bearer good-token" },
      body: "not json",
    }));
    expect(res.status).toBe(400);
  });

  it("caps the requested count so one call cannot run up the bill", async () => {
    anthropicReturns({ content: [{ text: "[]" }] });
    await POST(req({ body: { userContent: [{ type: "text", text: "x" }], count: 9999 } }));
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.system).toMatch(/Rules: 20 questions/);
  });
});

describe("upstream failures", () => {
  it("does not tell the client our key was rejected verbatim", async () => {
    anthropicReturns({ error: { message: "invalid x-api-key sk-ant-secret" } }, false, 401);
    const res = await POST(req());
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error).not.toMatch(/sk-ant/);
  });

  it("reports unparseable model output as a 502", async () => {
    anthropicReturns({ content: [{ text: "sorry, here are some questions:" }] });
    const res = await POST(req());
    expect(res.status).toBe(502);
  });

  it("rejects a non-array result", async () => {
    anthropicReturns({ content: [{ text: '{"q":"not an array"}' }] });
    const res = await POST(req());
    expect(res.status).toBe(502);
  });

  it("strips markdown fences the model adds anyway", async () => {
    anthropicReturns({ content: [{ text: '```json\n[{"q":"a"}]\n```' }] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).questions).toEqual([{ q: "a" }]);
  });
});

describe("rate limiting", () => {
  it("throttles a single user after the window fills", async () => {
    anthropicReturns({ content: [{ text: "[]" }] });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await POST(req())).status);
    expect(codes.filter(c => c === 429).length).toBeGreaterThan(0);
  });
});

// ── Provider selection and the Gemini path ──────────────────────────────
// The client's request shape does not change when the provider does, so these
// assert the translation in both directions: Anthropic content blocks going
// out as Gemini input, and Gemini's response coming back as the same
// { questions: [...] } the app already consumes.

function geminiReturns(payload, ok = true, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok, status, json: async () => payload });
  return globalThis.fetch;
}

const ONE_Q = [{ q: "x", opts: ["a", "b", "c", "d", "e"], ans: 2, exp: "e", optExp: ["w", "w", "", "w", "w"] }];

describe("provider selection", () => {
  it("uses Gemini when its key is set", async () => {
    process.env.GEMINI_API_KEY = "gem-test";
    const f = geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    await POST(req());
    expect(f.mock.calls[0][0]).toContain("generativelanguage.googleapis.com");
    delete process.env.GEMINI_API_KEY;
  });

  it("falls back to Anthropic when only that key is set", async () => {
    delete process.env.GEMINI_API_KEY;
    const f = geminiReturns({ content: [{ text: JSON.stringify(ONE_Q) }] });
    await POST(req());
    expect(f.mock.calls[0][0]).toContain("api.anthropic.com");
  });

  it("500s when neither key is present", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(req());
    expect(res.status).toBe(500);
  });
});

describe("Gemini request shape", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "gem-test"; });
  afterEach(() => { delete process.env.GEMINI_API_KEY; });

  it("sends the key as a header, never in the URL", async () => {
    const f = geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    await POST(req());
    const [url, init] = f.mock.calls[0];
    expect(url).not.toContain("gem-test");
    expect(init.headers["x-goog-api-key"]).toBe("gem-test");
  });

  it("translates a base64 PDF block into Gemini's document part", async () => {
    const f = geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    await POST(req({ body: { userContent: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BASE64" } },
      { type: "text", text: "Topic: Physiology" },
    ] } }));
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.input[0]).toEqual({ type: "document", data: "BASE64", mime_type: "application/pdf" });
    expect(sent.input[1]).toEqual({ type: "text", text: "Topic: Physiology" });
  });

  it("asks for JSON against a schema rather than trusting the prose", async () => {
    const f = geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    await POST(req());
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.response_format.mime_type).toBe("application/json");
    expect(sent.response_format.schema.properties.questions).toBeTruthy();
    expect(sent.system_instruction).toContain("MBChB");
  });
});

describe("Gemini response handling", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "gem-test"; });
  afterEach(() => { delete process.env.GEMINI_API_KEY; });

  it("unwraps the schema's questions object", async () => {
    geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    const body = await (await POST(req())).json();
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].q).toBe("x");
  });

  it("puts null back at the answer index so the shape matches the bank", async () => {
    geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    const body = await (await POST(req())).json();
    expect(body.questions[0].optExp[2]).toBeNull();
    expect(body.questions[0].optExp[0]).toBe("w");
  });

  it("reads text out of steps when output_text is absent", async () => {
    geminiReturns({ steps: [{ content: [{ text: JSON.stringify(ONE_Q) }] }] });
    const body = await (await POST(req())).json();
    expect(body.questions).toHaveLength(1);
  });

  it("does not tell the client our Gemini key was rejected verbatim", async () => {
    geminiReturns({ error: { message: "API key not valid: AIzaSyC-real-key" } }, false, 403);
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).not.toContain("AIzaSy");
  });
});

describe("free-tier quota handling", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "gem-test"; });
  afterEach(() => { delete process.env.GEMINI_API_KEY; });

  it("retries once when the shared per-minute quota is hit", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { ok: false, status: 429, json: async () => ({ error: { message: "quota" } }) }
        : { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ questions: ONE_Q }) }) };
    });
    const res = await POST(req());
    expect(call).toBe(2);
    expect(res.status).toBe(200);
  });

  it("says what actually happened when the retry also fails", async () => {
    geminiReturns({ error: { message: "RESOURCE_EXHAUSTED" } }, false, 429);
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body.error).toMatch(/generating at once/i);
  });

  it("sends the configured default model", async () => {
    const f = geminiReturns({ output_text: JSON.stringify({ questions: ONE_Q }) });
    await POST(req());
    expect(JSON.parse(f.mock.calls[0][1].body).model).toBe("gemini-3.6-flash");
  });
});

describe("transient upstream failures", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "gem-test"; });
  afterEach(() => { delete process.env.GEMINI_API_KEY; });

  it("retries an overloaded model and succeeds on the second go", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { ok: false, status: 503, json: async () => ({ error: { message: "overloaded" } }) }
        : { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ questions: ONE_Q }) }) };
    });
    const res = await POST(req());
    expect(call).toBe(2);
    expect(res.status).toBe(200);
  });

  it("gives up after three attempts and says the far end was busy", async () => {
    const f = geminiReturns({ error: { message: "high demand" } }, false, 503);
    const res = await POST(req());
    const body = await res.json();
    expect(f).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(503);
    expect(body.error).toMatch(/busy/i);
    expect(body.error).not.toMatch(/gemini/i);
  });

  it("does not retry a request that was simply wrong", async () => {
    const f = geminiReturns({ error: { message: "Model 'nope' not found" } }, false, 404);
    await POST(req());
    expect(f).toHaveBeenCalledTimes(1);
  });
});
