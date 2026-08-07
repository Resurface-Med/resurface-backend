import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST, OPTIONS } from "../app/api/generate/route.js";

// Guards the parts that protect the API key and the bill: the access code,
// the CORS allowlist, and never echoing an upstream auth failure to the client.

const ORIGIN = "https://app.resurface.example";

function req({ origin = ORIGIN, passcode = "test-code", body = { userContent: [{ type: "text", text: "x" }] }, ip } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) headers.set("origin", origin);
  if (passcode !== null) headers.set("x-resurface-passcode", passcode);
  headers.set("x-forwarded-for", ip || Math.random().toString(36));
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

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.RESURFACE_PASSCODE = "test-code";
  process.env.ALLOWED_ORIGINS = `${ORIGIN},http://localhost:5173`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("access code", () => {
  it("rejects a wrong code", async () => {
    const res = await POST(req({ passcode: "nope" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/access code/i);
  });

  it("rejects a missing code", async () => {
    const res = await POST(req({ passcode: null }));
    expect(res.status).toBe(401);
  });

  it("accepts the right code", async () => {
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
      headers: { "content-type": "application/json", origin: ORIGIN, "x-resurface-passcode": "test-code" },
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
  it("throttles a single caller after the window fills", async () => {
    anthropicReturns({ content: [{ text: "[]" }] });
    const ip = "10.0.0.1";
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await POST(req({ ip }))).status);
    expect(codes.filter(c => c === 429).length).toBeGreaterThan(0);
  });
});
