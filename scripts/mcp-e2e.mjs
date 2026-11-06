// Drives every connector tool against the live server the way Claude does,
// in a throwaway deck that is deleted at the end, and times each call.
//
//   node scripts/mcp-e2e.mjs <token-file> [connector-url]
//
// The token file comes from scripts/mcp-login.mjs. set_deck_public is not
// run: it would show a test deck to every student.

import { readFileSync } from "node:fs";

const [tokenFile, url = "https://api.tryresurface.com/api/mcp"] = process.argv.slice(2);
const { access_token } = JSON.parse(readFileSync(tokenFile, "utf8"));
const SB = "https://uhqpljteohitvytwfadp.supabase.co";
const KEY = "sb_publishable_0ZlQhc0Gn_bD5-AFIgPOrw_xKVHv8hJ";

let seq = 0;
const timings = [];
async function rpc(method, params) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access_token}`, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return { result: body.result, ms, bytes: JSON.stringify(body).length };
}
async function tool(name, args, { expectError = false } = {}) {
  const { result, ms, bytes } = await rpc("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  timings.push({ name, ms, bytes, ok: !result.isError });
  if (!!result.isError !== expectError) throw new Error(`${name} ${expectError ? "should have failed" : "failed"}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const check = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`  ok  ${what}`); };

const created = { decks: [], questions: [], images: [] };
const note = {
  title: "Acute pancreatitis",
  body: "Inflammation of the pancreas from premature enzyme activation.\n\n**Causes**\n- ==Gallstones and alcohol cause most cases==\n- Drugs include azathioprine and furosemide\n\n**Severity**\n- Glasgow score of 3 or more predicts severe disease",
};

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  console.log(`initialize ${init.ms}ms`);
  const list = await rpc("tools/list", {});
  console.log(`tools/list ${list.ms}ms, ${list.result.tools.length} tools, ${list.bytes} bytes`);

  console.log("decks");
  const decks = await tool("list_decks", {});
  check(Array.isArray(decks.decks ?? decks) , "list_decks returns decks");
  const top = await tool("create_deck", { name: "zz MCP test (delete me)" });
  created.decks.push(top.created.id);
  const sub = await tool("create_deck", { name: "Sub B", parent_deck_id: top.created.id });
  const subA = await tool("create_deck", { name: "Sub A", parent_deck_id: top.created.id });
  created.decks.push(sub.created.id, subA.created.id);
  await tool("update_deck", { deck_id: subA.created.id, before_deck_id: sub.created.id });
  await tool("update_deck", { deck_id: sub.created.id, name: "Sub B renamed" });

  console.log("questions");
  const added = await tool("add_questions", {
    deck_id: sub.created.id,
    questions: [
      { question: "A 45-year-old with epigastric pain radiating to the back. Commonest cause?", options: ["Gallstones", "Hypercalcaemia", "Mumps", "Trauma"], answer: "A", explanation: "Gallstones are the commonest cause in the UK.", why_wrong: { B: "Rare.", C: "Rare in adults.", D: "Less common." } },
      { question: "Which drug can cause pancreatitis?", options: ["Paracetamol", "Azathioprine", "Amoxicillin"], answer: "B", explanation: "Azathioprine is a recognised cause." },
      { question: "A Glasgow score of 3 or more suggests?", options: ["Mild disease", "Severe disease"], answer: "B", explanation: "3 or more predicts severe pancreatitis." },
    ],
  });
  const ids = added.added;
  created.questions.push(...ids);
  check(ids.length === 3, "add_questions adds 3");

  const deck = await tool("get_deck", { deck_id: sub.created.id });
  check(deck.total === 3 && deck.questions[0].answer?.startsWith("A:"), "get_deck short form");

  console.log("editing");
  // The shapes a model really sends: nested JSON as text, ids as text,
  // answers with brackets, highlight lines with list marks and == marks.
  const e1 = await tool("edit_questions", {
    edits: JSON.stringify([
      { question_id: String(ids[0]), topic_note: note, highlight_lines: ["- ==gallstones and alcohol cause most cases=="] },
      { question_id: ids[1], topic_note: JSON.stringify(note), highlight_lines: ["Drugs include azathioprine and furosemide"], answer: "B)" },
      { question_id: ids[2], topic_note: note, highlight_lines: "Glasgow score of 3 or more predicts severe disease" },
    ]),
  });
  check(e1.updated === 3, "batch edit saves 3 notes in one call");
  const full = await tool("get_questions", { question_ids: ids });
  check(Object.keys(full.notes ?? {}).length === 1, "shared note given once");
  check(full.questions[0].highlight_lines[0] === "Gallstones and alcohol cause most cases", "highlight cleaned to the note's own text");
  check(full.questions[1].answer === "B", "answer B) read as B");

  const old = await tool("edit_question", { question_id: ids[2], explanation: "Edited through the old name." });
  check(old.updated === 1, "old edit_question name still works");
  await tool("edit_questions", { edits: [{ question_id: ids[0], answer: "Z" }] }, { expectError: true });
  await tool("edit_questions", { edits: [{ question_id: ids[0], highlight_lines: ["Not in the note at all"] }] }, { expectError: true });
  const after = await tool("get_questions", { question_ids: [ids[0]] });
  check(after.questions[0].answer === "A", "a rejected edit changes nothing");
  await tool("edit_questions", { edits: [{ question_id: 999999999, explanation: "x" }] }, { expectError: true });

  // a hundred-edit batch, to time it
  const many = await tool("add_questions", { deck_id: sub.created.id, questions: Array.from({ length: 40 }, (_, i) => ({ question: `Bulk ${i}?`, options: ["a", "b"], answer: "A", explanation: "e" })) });
  created.questions.push(...many.added);
  const bulk = await tool("edit_questions", { edits: many.added.map(id => ({ question_id: id, explanation: "bulk edited", topic_note: note })) });
  check(bulk.updated === 40, "40 edits in one call");

  console.log("search, move, image");
  const found = await tool("search_questions", { text: "azathioprine", deck_id: top.created.id });
  check(found.questions.some(q => q.id === ids[1]), "search finds by option text inside the deck");
  const pct = await tool("search_questions", { text: "100%" });
  check(Array.isArray(pct.questions), "search with % does not break");
  await tool("move_questions", { question_ids: [ids[2]], deck_id: subA.created.id });
  const moved = await tool("get_deck", { deck_id: subA.created.id });
  check(moved.total === 1, "move_questions moved one");
  const img = await tool("add_image", { question_id: ids[0], image_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png", place: "explanation", caption: "Test figure" });
  created.images.push(img.attached);
  check(/\.png$/.test(img.attached), "add_image stored a copy");
  const withImg = await tool("get_questions", { question_ids: [ids[0]] });
  check(withImg.questions[0].explanation.includes(img.attached), "figure line in the explanation");

  console.log("guards");
  await tool("delete_deck", { deck_id: top.created.id }, { expectError: true });
  await tool("update_deck", { deck_id: top.created.id, parent_deck_id: sub.created.id }, { expectError: true });
} finally {
  console.log("cleanup");
  try {
    if (created.questions.length) await tool("delete_questions", { question_ids: created.questions });
    for (const d of [...created.decks].reverse()) await tool("delete_deck", { deck_id: d });
    for (const path of created.images) {
      await fetch(`${SB}/storage/v1/object/question-images/${path}`, { method: "DELETE", headers: { apikey: KEY, authorization: `Bearer ${access_token}` } });
    }
    console.log("  cleaned up");
  } catch (e) { console.log("  CLEANUP FAILED", e.message, JSON.stringify(created)); }
  console.log("\ntimings (ms, response bytes)");
  for (const t of timings) console.log(`  ${t.name.padEnd(18)} ${String(t.ms).padStart(5)}  ${String(t.bytes).padStart(6)}${t.ok ? "" : "  (expected error)"}`);
}
