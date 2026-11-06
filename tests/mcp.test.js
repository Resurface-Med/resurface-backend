import { describe, expect, it } from "vitest";
import { handleBody, handleMessage } from "../lib/mcp/protocol.js";
import { STEP, buildPayload, checkHighlights, fullSet, placeAmong, present, summary, toolsFor } from "../lib/mcp/tools.js";

const fakeTools = {
  list: () => [{ name: "echo", inputSchema: { type: "object" } }],
  has: n => n === "echo" || n === "boom",
  call: async (n, a) => { if (n === "boom") throw new Error("nope"); return a; },
};

describe("protocol", () => {
  it("initializes with the client's version when supported", async () => {
    const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, fakeTools);
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeTruthy();
  });
  it("falls back to its newest version", async () => {
    const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, fakeTools);
    expect(r.result.protocolVersion).toBe("2025-06-18");
  });
  it("gives notifications no reply", async () => {
    expect(await handleBody({ jsonrpc: "2.0", method: "notifications/initialized" }, fakeTools)).toBeNull();
  });
  it("returns tool failures as results Claude can read", async () => {
    const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "boom" } }, fakeTools);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe("nope");
  });
  it("rejects unknown tools and methods", async () => {
    expect((await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } }, fakeTools)).error.code).toBe(-32602);
    expect((await handleMessage({ jsonrpc: "2.0", id: 4, method: "nope" }, fakeTools)).error.code).toBe(-32601);
  });
  it("answers batches", async () => {
    const out = await handleBody([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }], fakeTools);
    expect(out).toHaveLength(1);
  });
});

describe("tool definitions", () => {
  it("lists every tool without its code", () => {
    const list = toolsFor({}).list();
    expect(list.length).toBeGreaterThan(8);
    for (const t of list) { expect(t.run).toBeUndefined(); expect(t.inputSchema.type).toBe("object"); }
  });
});

describe("buildPayload", () => {
  const base = { question: "Q?", options: ["a", "b", "c"], answer: "B", explanation: "because", why_wrong: { A: "no a", C: "no c" } };
  it("builds a new question", () => {
    const p = buildPayload(base);
    expect(p).toMatchObject({ q: "Q?", opts: ["a", "b", "c"], ans: 1, exp: "because", optExp: ["no a", null, "no c"] });
  });
  it("needs an explanation for a new question", () => {
    expect(() => buildPayload({ ...base, explanation: "" })).toThrow(/explanation/);
  });
  it("edits only what is sent", () => {
    const existing = buildPayload(base);
    const p = buildPayload({ answer: "C" }, existing);
    expect(p.ans).toBe(2);
    expect(p.optExp).toEqual(["no a", "", null]);
    expect(p.q).toBe("Q?");
  });
  it("rejects an answer outside the options", () => {
    expect(() => buildPayload({ ...base, answer: "E" })).toThrow(/A to C/);
  });
  it("checks highlight lines against the note", () => {
    const topic = { title: "T", body: "Intro.\n\n- ==Key line here==\n- Other" };
    expect(() => buildPayload({ ...base, topic_note: topic, highlight_lines: ["Key line here"] })).not.toThrow();
    expect(() => buildPayload({ ...base, topic_note: topic, highlight_lines: ["Not there"] })).toThrow(/word for word/);
    expect(() => checkHighlights(topic, ["a = b"])).toThrow(/"="/);
  });
  it("present round-trips the letters", () => {
    const q = present({ id: 7, deck_id: "d", payload: buildPayload(base) });
    expect(q.answer).toBe("B");
    expect(q.options).toEqual({ A: "a", B: "b", C: "c" });
    expect(q.why_wrong).toEqual({ A: "no a", C: "no c" });
  });
});

describe("placeAmong", () => {
  const sibs = [{ id: "a", position: 0 }, { id: "b", position: STEP }, { id: "c", position: 2 * STEP }];
  it("goes to the end by default", () => expect(placeAmong(sibs).position).toBe(3 * STEP));
  it("goes into an empty parent at 0", () => expect(placeAmong([]).position).toBe(0));
  it("goes before the first", () => expect(placeAmong(sibs, { before: "a" }).position).toBe(-STEP));
  it("takes the midpoint", () => expect(placeAmong(sibs, { after: "a" }).position).toBe(STEP / 2));
  it("renumbers when there is no room", () => {
    const tight = [{ id: "a", position: 5 }, { id: "b", position: 6 }];
    const r = placeAmong(tight, { after: "a" });
    expect(r.position).toBe(STEP);
    expect(r.renumber).toEqual([{ id: "a", position: 0 }, { id: "b", position: 2 * STEP }]);
  });
  it("rejects a sibling that is not there", () => expect(() => placeAmong(sibs, { before: "z" })).toThrow());
});

describe("short and full forms", () => {
  const note = { title: "Gallstones", body: "Intro.\n\n- ==Key==" };
  const mk = (id, extra = {}) => ({ id, deck_id: "d", payload: { ...buildPayload({ question: "Q " + id + " " + "x".repeat(300), options: ["a", "b"], answer: "A", explanation: "e" }), ...extra } });
  it("clips long questions in the short form", () => {
    const s = summary(mk(1, { topic: note }));
    expect(s.question.length).toBeLessThanOrEqual(160);
    expect(s.answer).toBe("A: a");
    expect(s.note).toBe("Gallstones");
  });
  it("gives a shared note once", () => {
    const out = fullSet([mk(1, { topic: note }), mk(2, { topic: note }), mk(3)]);
    expect(Object.keys(out.notes)).toEqual(["n1"]);
    expect(out.questions.map(q => q.note)).toEqual(["n1", "n1", undefined]);
    expect(out.questions[0].topic_note).toBeUndefined();
  });
});

describe("aliases", () => {
  it("still answers the old edit_question name, routed to edit_questions", async () => {
    const tools = toolsFor({});
    expect(tools.has("edit_question")).toBe(true);
    expect(tools.list().some(t => t.name === "edit_question")).toBe(false);
  });
});
