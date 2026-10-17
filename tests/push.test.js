import { describe, it, expect, vi, beforeEach } from "vitest";

const sent = [];
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub, payload) => {
      if (sub.endpoint.includes("gone")) { const e = new Error("Gone"); e.statusCode = 410; throw e; }
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    },
  },
}));
const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: (...a) => mockGetUser(...a) } }) }));

const run = await import("../app/api/push/run/route.js");
const test = await import("../app/api/push/test/route.js");
const sub = endpoint => ({ endpoint, keys: { p256dh: "p", auth: "a" } });
const post = (url, body, headers = {}) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  sent.length = 0;
  process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv"; process.env.PUSH_SECRET = "s3cret";
  process.env.SUPABASE_URL = "https://t.supabase.co"; process.env.SUPABASE_ANON_KEY = "k";
  mockGetUser.mockImplementation(async t => (t === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: new Error("no") }));
});

describe("/api/push/run", () => {
  it("refuses without the shared secret", async () => {
    expect((await run.POST(post("https://x/api/push/run", { items: [] }))).status).toBe(401);
    expect((await run.POST(post("https://x/api/push/run", { items: [] }, { authorization: "Bearer wrong" }))).status).toBe(401);
  });
  it("sends each reminder and reports the addresses that are gone", async () => {
    const res = await run.POST(post("https://x/api/push/run", { items: [
      { subscription: sub("https://push.example/a"), title: "Resurface", body: "You have 12 questions due.", badge: 12 },
      { subscription: sub("https://push.example/gone"), title: "Resurface", body: "x" },
      { subscription: { endpoint: "nope" }, title: "bad" },
    ] }, { authorization: "Bearer s3cret" }));
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.gone).toEqual(["https://push.example/gone"]);
    expect(sent[0].payload).toMatchObject({ body: "You have 12 questions due.", badge: 12 });
  });
});

describe("/api/push/test", () => {
  it("needs a signed-in user", async () => {
    expect((await test.POST(post("https://x/api/push/test", { subscription: sub("https://push.example/a") }))).status).toBe(401);
  });
  it("sends a test to the device that asked", async () => {
    const res = await test.POST(post("https://x/api/push/test", { subscription: sub("https://push.example/me") }, { authorization: "Bearer good" }));
    expect(res.status).toBe(200);
    expect(sent[0].endpoint).toBe("https://push.example/me");
  });
});
