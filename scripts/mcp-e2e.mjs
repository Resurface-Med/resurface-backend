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
  body: "Pancreatitis is the pancreas digesting itself; find the cause, then judge how severe it is.\n\n**Causes**\n- ==Gallstones and alcohol cause most cases==\n- Drugs include azathioprine and furosemide\n\n**Severity**\n- Glasgow score of 3 or more predicts severe disease\n\n**Where marks are lost**\n- Gallstones, not alcohol, lead in the UK",
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
      { question: "A 45-year-old has epigastric pain radiating to the back and a raised amylase. What is the most likely cause?", options: ["Gallstones", "Hypercalcaemia", "Mumps", "Trauma", "Hypertriglyceridaemia"], answer: "A", explanation: "Gallstones are the commonest cause in the UK. They obstruct the ampulla.", why_wrong: { B: "Rare.", C: "Rare in adults.", D: "Less common.", E: "Less common." } },
      { question: "Which drug is a recognised cause of pancreatitis?", options: ["Paracetamol", "Azathioprine", "Amoxicillin", "Omeprazole", "Metformin"], answer: "B", explanation: "Azathioprine causes pancreatitis. It is idiosyncratic.", why_wrong: { A: "No.", C: "No.", D: "No.", E: "No." } },
      { question: "What does a Glasgow score of 3 or more suggest?", options: ["1 point", "2 points", "3 points", "4 points", "5 points"], ordered: true, answer: "C", explanation: "3 or more predicts severe disease. It prompts HDU review.", why_wrong: { A: "x", B: "x", D: "x", E: "x" } },
    ],
  });
  const ids = added.added;
  // the four-option question Claude wrote earlier today must be refused, with every problem named
  const bareNote = await tool("edit_questions", { edits: [{ question_id: ids[0], topic_note: { title: "T", body: "**Shape**\n- a\n- ==b==" } }] }, { expectError: true });
  check(/open with one plain sentence/.test(bareNote), "a note with no opening sentence is refused");
  const refused = await tool("add_questions", { deck_id: sub.created.id, questions: [{ question: "Name the commonest cause", options: ["Gallstones", "Alcohol", "Drugs", "Trauma"], answer: "A", explanation: "e" }] }, { expectError: true });
  check(/4 options/.test(refused) && /why_wrong/.test(refused) && /\?/.test(refused), "a four-option question is refused with every problem listed");
  const style = await tool("get_question_style", {});
  check(style.exemplars.length === 5, "get_question_style gives the rules and five exemplars");
  created.questions.push(...ids);
  check(ids.length === 3, "add_questions adds 3");
  const sorted = await tool("get_questions", { question_ids: ids });
  check(sorted.questions[1].options.A === "Amoxicillin" && sorted.questions[1].answer === "B", "options alphabetised, answer follows");
  check(sorted.questions[2].options.A === "1 point", "ordered options keep their order");

  const deck = await tool("get_deck", { deck_id: sub.created.id });
  check(deck.total === 3 && deck.questions[0].answer?.startsWith("A:"), "get_deck short form");
  const one = await tool("list_decks", { deck_id: top.created.id });
  check(one.decks[0].decks.length === 2, "list_decks for one deck");

  console.log("editing");
  // The shapes a model really sends: nested JSON as text, ids as text,
  // answers with brackets, highlight lines with list marks and == marks.
  const e1 = await tool("edit_questions", {
    notes: { n1: note },
    edits: JSON.stringify([
      { question_id: String(ids[0]), topic_note: "n1", highlight_lines: ["- ==gallstones and alcohol cause most cases=="] },
      { question_id: ids[1], topic_note: "n1", highlight_lines: ["Drugs include azathioprine and furosemide"], answer: "B)" },
      { question_id: ids[2], topic_note: "n1", highlight_lines: "Glasgow score of 3 or more predicts severe disease" },
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
  const many = await tool("add_questions", { deck_id: sub.created.id, questions: Array.from({ length: 40 }, (_, i) => ({ question: `Bulk ${i}?`, options: ["v", "w", "x", "y", "z"], answer: "A", explanation: "e", why_wrong: { B: "b", C: "c", D: "d", E: "e" } })) });
  created.questions.push(...many.added);
  const bulk = await tool("edit_questions", { notes: { n1: note }, edits: many.added.map(id => ({ question_id: id, explanation: "bulk edited", topic_note: "n1" })) });
  check(bulk.updated === 40, "40 edits in one call, note written once");
  const mixed = await tool("add_questions", { deck_id: sub.created.id, questions: [
    { question: "Good one?", options: ["v", "w", "x", "y", "z"], answer: "A", explanation: "e", why_wrong: { B: "b", C: "c", D: "d", E: "e" } },
    { question: "Bad one", options: ["v", "w"], answer: "A", explanation: "e" },
  ] });
  created.questions.push(...mixed.added);
  check(mixed.added.length === 1 && mixed.refused[0].question === 2, "good questions save, only the bad one comes back");

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
  const page = await tool("add_image", { question_id: ids[1], image_url: "https://commons.wikimedia.org/wiki/File:PNG_transparency_demonstration_1.png", place: "question" });
  created.images.push(page.attached);
  check(!!page.attached, "add_image from a Commons File: page");
  check(/\.(png|webp)$/.test(img.attached), "add_image stored a copy");
  const withImg = await tool("get_questions", { question_ids: [ids[0]] });
  check(withImg.questions[0].explanation.includes(img.attached), "figure line in the explanation");

  console.log("upkeep and undo");
  const health = await tool("check_deck", { deck_id: top.created.id });
  check(health.questions > 0 && Array.isArray(health.problems), "check_deck lists problems");
  const before = (await tool("get_questions", { question_ids: [ids[0]] })).questions[0].explanation;
  const ed = await tool("edit_questions", { edits: [{ question_id: ids[0], explanation: "A mistake to undo." }] });
  check(!!ed.undo_id, "an edit replies with an undo_id");
  const del = await tool("delete_questions", { question_ids: [ids[1]] });
  const changes = await tool("list_changes", { limit: 5 });
  check(changes.changes[0].undo_id === del.undo_id && changes.changes[0].deleted === 1, "list_changes shows the deletion first");
  const u1 = await tool("undo_change", { undo_id: ed.undo_id });
  const u2 = await tool("undo_change", { undo_id: del.undo_id });
  check(u1.restored === 1 && u2.brought_back === 1, "undo restores the edit and brings back the deleted question");
  const back = await tool("get_questions", { question_ids: [ids[0], ids[1]] });
  check(back.questions[0].explanation === before && back.questions.length === 2, "both are exactly as before");
  await tool("undo_change", { undo_id: ed.undo_id }, { expectError: true });
  const hard = await tool("hardest_questions", { deck_id: top.created.id, min_attempts: 1 });
  check(Array.isArray(hard.questions), "hardest_questions answers for a new deck");
  const reps = await tool("list_reports", {});
  check(typeof reps.reports === "number", "list_reports answers");
  if (process.env.BIG_DECK) {
    const big = await tool("check_deck", { deck_id: process.env.BIG_DECK });
    console.log(`  big deck: ${big.questions} questions, ${big.decks} decks: ${JSON.stringify((big.problems ?? []).map(p => [p.problem, p.count]))}`);
    const bh = await tool("hardest_questions", { deck_id: process.env.BIG_DECK, limit: 5 });
    console.log(`  hardest: ${JSON.stringify(bh.questions?.map(q => [q.correct_pct, q.attempts]) ?? bh)}`);
  }

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
