// What Claude can do in Resurface through the connector.
//
// Every call runs as the person who connected: `db` is a Supabase client
// carrying their own token, so the same row-level security that guards the
// app guards this. Nothing here uses the service key. The tools only reach the
// person's own decks and questions; the one exception is public/hidden, which
// goes through the same admin functions the Admin page uses, and those check
// is_admin() in Postgres themselves.
//
// Question ids are the database's (generated_questions.id), not the app's
// offset ids.

export const STEP = 1024;
const LETTERS = "ABCDEFGH";
const IMAGE_BUCKET = "question-images";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// ---------- small pure helpers (tested) ----------

export const letter = i => LETTERS[i];
export function indexOf(l, n) {
  const i = LETTERS.indexOf(String(l ?? "").trim().toUpperCase());
  if (i < 0 || i >= n) throw new Error(`Answer must be a letter from A to ${LETTERS[n - 1]}.`);
  return i;
}

/** A stored question as Claude should read it. */
export function present(row) {
  const p = row.payload ?? {};
  const opts = Array.isArray(p.opts) ? p.opts : [];
  const why = {};
  (p.optExp ?? []).forEach((t, i) => { if (t && i !== p.ans) why[letter(i)] = t; });
  return {
    id: row.id,
    deck_id: row.deck_id,
    question: p.q ?? "",
    options: Object.fromEntries(opts.map((o, i) => [letter(i), o])),
    answer: Number.isInteger(p.ans) ? letter(p.ans) : null,
    explanation: p.exp ?? "",
    why_wrong: why,
    topic_note: p.topic ?? null,
    highlight_lines: p.hl ?? [],
    image: p.img ?? null,
  };
}

const clip = (t, n) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };

/** The short form, for lists: enough to recognise a question and pick it. */
export function summary(row) {
  const p = row.payload ?? {};
  const ans = Number.isInteger(p.ans) ? letter(p.ans) : null;
  return {
    id: row.id,
    ...(row.deck_id ? { deck_id: row.deck_id } : {}),
    question: clip(p.q, 160),
    answer: ans ? `${ans}: ${clip(p.opts?.[p.ans], 80)}` : null,
    ...(p.topic?.title ? { note: p.topic.title } : {}),
    ...(p.img ? { image: true } : {}),
  };
}

/** Full questions, with each distinct topic note given once. */
export function fullSet(rows) {
  const notes = {};
  const keyOf = new Map();
  const questions = rows.map(r => {
    const { topic_note, ...q } = present(r);
    if (!topic_note) return q;
    const sig = `${topic_note.title}\u0000${topic_note.body}`;
    if (!keyOf.has(sig)) { const k = `n${keyOf.size + 1}`; keyOf.set(sig, k); notes[k] = topic_note; }
    return { ...q, note: keyOf.get(sig) };
  });
  return { questions, ...(keyOf.size ? { notes } : {}) };
}

/** The note's text as the app shows it, for checking highlight lines. */
const plainNote = body => String(body ?? "").replace(/==/g, "");

export function checkHighlights(topic, hl) {
  if (!hl) return;
  if (!Array.isArray(hl)) throw new Error("highlight_lines must be a list of lines.");
  const text = plainNote(topic?.body);
  for (const line of hl) {
    if (typeof line !== "string" || !line.trim()) throw new Error("Each highlight line must be text.");
    if (line.includes("=")) throw new Error(`Highlight lines cannot contain "=": ${line}`);
    if (!text.includes(line)) throw new Error(`This highlight line is not in the topic note word for word: ${line}`);
  }
}

/**
 * Turns what Claude sends for a question into a stored payload, merged over
 * the existing one when editing. Only the fields it sends are changed.
 */
export function buildPayload(input, existing = {}) {
  const p = { ...existing };
  if (input.question !== undefined) p.q = String(input.question).trim();
  if (input.options !== undefined) {
    const opts = Array.isArray(input.options) ? input.options : Object.values(input.options ?? {});
    if (opts.length < 2 || opts.length > 8) throw new Error("A question needs 2 to 8 options.");
    p.opts = opts.map(o => String(o).trim());
    // Keep each option's "why" in step with its option; a changed list
    // without new whys keeps the old ones by position.
    const old = Array.isArray(existing.optExp) ? existing.optExp : [];
    p.optExp = p.opts.map((_, i) => old[i] ?? "");
  }
  const n = (p.opts ?? []).length;
  if (input.answer !== undefined) p.ans = indexOf(input.answer, n);
  if (input.explanation !== undefined) p.exp = String(input.explanation);
  if (input.why_wrong !== undefined) {
    const base = Array.isArray(p.optExp) ? [...p.optExp] : new Array(n).fill("");
    for (const [l, t] of Object.entries(input.why_wrong ?? {})) base[indexOf(l, n)] = String(t);
    p.optExp = base;
  }
  if (input.topic_note !== undefined) {
    if (input.topic_note === null) { delete p.topic; delete p.hl; }
    else {
      const { title, body } = input.topic_note;
      if (!title || !body) throw new Error("A topic note needs a title and a body.");
      p.topic = { title: String(title), body: String(body) };
    }
  }
  if (input.highlight_lines !== undefined) p.hl = input.highlight_lines;
  if (p.topic && p.hl) checkHighlights(p.topic, p.hl);

  if (!p.q) throw new Error("The question text is empty.");
  if (!Array.isArray(p.opts) || p.opts.length < 2) throw new Error("A question needs at least 2 options.");
  if (!Number.isInteger(p.ans) || p.ans < 0 || p.ans >= p.opts.length) throw new Error("The answer does not match an option.");
  if (!existing.q && !String(p.exp ?? "").trim()) throw new Error("A new question needs an explanation.");
  const whys = Array.isArray(p.optExp) ? p.optExp : [];
  p.optExp = p.opts.map((_, i) => (i === p.ans ? null : (whys[i] ?? "")));
  return p;
}

/**
 * Where a deck lands among its new siblings. Returns the position for the
 * moved deck and any siblings that need renumbering because there was no room.
 * `siblings` excludes the moved deck and is in display order.
 */
export function placeAmong(siblings, { before, after } = {}) {
  let i = siblings.length;                      // default: at the end
  if (before) { i = siblings.findIndex(s => s.id === before); if (i < 0) throw new Error("before_deck_id is not one of the new siblings."); }
  else if (after) { const j = siblings.findIndex(s => s.id === after); if (j < 0) throw new Error("after_deck_id is not one of the new siblings."); i = j + 1; }
  const prev = siblings[i - 1]?.position;
  const next = siblings[i]?.position;
  if (prev === undefined && next === undefined) return { position: 0, renumber: [] };
  if (prev === undefined) return { position: next - STEP, renumber: [] };
  if (next === undefined) return { position: prev + STEP, renumber: [] };
  if (next - prev >= 2) return { position: Math.floor((prev + next) / 2), renumber: [] };
  // No room: space everyone out again, with the moved deck at index i.
  const renumber = siblings.map((s, k) => ({ id: s.id, position: (k < i ? k : k + 1) * STEP }));
  return { position: i * STEP, renumber };
}

const byOrder = (a, b) => (a.position ?? 0) - (b.position ?? 0)
  || String(a.name).localeCompare(String(b.name), "en", { numeric: true })
  || String(a.created_at).localeCompare(String(b.created_at));

// ---------- database access ----------

async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function myDecks(ctx) {
  return all(() => ctx.db.from("decks").select("id, name, parent_id, position, created_at").eq("owner_id", ctx.userId).order("id"));
}

async function myDeck(ctx, id) {
  const { data, error } = await ctx.db.from("decks").select("id, name, parent_id, position, created_at").eq("id", id).eq("owner_id", ctx.userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No deck of yours has id ${id}. Use list_decks to find it.`);
  return data;
}

async function publicStatus(ctx) {
  const { data, error } = await ctx.db.rpc("admin_featured_decks");
  if (error) return new Map();                   // not an admin: nothing is shown as public
  return new Map((data ?? []).map(r => [r.deck_id, r.listed ? "public" : "featured, not yet public"]));
}

async function myQuestions(ctx, ids) {
  const { data, error } = await ctx.db.from("generated_questions").select("id, deck_id, payload").in("id", ids).eq("user_id", ctx.userId);
  if (error) throw new Error(error.message);
  const missing = ids.filter(id => !data.some(r => r.id === id));
  if (missing.length) throw new Error(`These question ids are not yours or do not exist: ${missing.join(", ")}`);
  return data;
}

function subtree(decks, rootId) {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decks) if (d.parent_id && ids.has(d.parent_id) && !ids.has(d.id)) { ids.add(d.id); grew = true; }
  }
  return ids;
}

// ---------- the tools ----------

const id = { type: "string", description: "A deck id from list_decks." };
const qid = { type: "integer", description: "A question id." };
const questionShape = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", items: { type: "string" }, description: "2 to 8 options, in order A, B, C…" },
    answer: { type: "string", description: "The correct option's letter." },
    explanation: { type: "string", description: "Why the answer is right. A line '![caption](path)' shows a picture." },
    why_wrong: { type: "object", additionalProperties: { type: "string" }, description: "Letter → why that option is wrong." },
    topic_note: { type: ["object", "null"], properties: { title: { type: "string" }, body: { type: "string" } }, description: "Title and body; body uses **Heading** lines, '- ' points and one ==highlight==. null removes it." },
    highlight_lines: { type: "array", items: { type: "string" }, description: "Lines copied word for word from the topic note to highlight for this question." },
  },
};

export const TOOLS = [
  {
    name: "list_decks",
    title: "List decks",
    description: "Lists all of your decks as a tree, with ids, question counts and whether each is public.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(ctx) {
      const [decks, status, counted] = await Promise.all([myDecks(ctx), publicStatus(ctx), ctx.db.rpc("my_deck_counts")]);
      if (counted.error) throw new Error(counted.error.message);
      const counts = new Map((counted.data ?? []).map(r => [r.deck_id, r.questions]));
      const kids = parent => decks.filter(d => (d.parent_id ?? null) === parent).sort(byOrder).map(d => ({
        id: d.id, name: d.name,
        questions: counts.get(d.id) ?? 0,
        ...(status.has(d.id) ? { public: status.get(d.id) } : {}),
        ...(decks.some(c => c.parent_id === d.id) ? { decks: kids(d.id) } : {}),
      }));
      return { decks: kids(null) };
    },
  },
  {
    name: "get_deck",
    title: "Read a deck",
    description: "Lists the questions in one deck (not its sub-decks) in short form: id, the start of the question, the answer and its topic note's title. Pages of 100. Use get_questions for the full text of the ones you need.",
    inputSchema: { type: "object", properties: { deck_id: id, page: { type: "integer", minimum: 1, default: 1 } }, required: ["deck_id"] },
    annotations: { readOnlyHint: true },
    async run(ctx, { deck_id, page = 1 }) {
      const from = (Math.max(1, page) - 1) * 100;
      const [deck, res] = await Promise.all([
        myDeck(ctx, deck_id),
        ctx.db.from("generated_questions").select("id, deck_id, payload", { count: "exact" })
          .eq("deck_id", deck_id).eq("user_id", ctx.userId).order("id").range(from, from + 99),
      ]);
      if (res.error) throw new Error(res.error.message);
      const more = res.count > from + res.data.length;
      return { deck: { id: deck.id, name: deck.name }, total: res.count, page, ...(more ? { next_page: page + 1 } : {}), questions: res.data.map(summary) };
    },
  },
  {
    name: "get_questions",
    title: "Read questions in full",
    description: "Full text of up to 50 questions by id: options, answer, explanation, why each wrong option is wrong, and topic notes. A note shared by several questions is given once under notes and referred to by key.",
    inputSchema: { type: "object", properties: { question_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 } }, required: ["question_ids"] },
    annotations: { readOnlyHint: true },
    async run(ctx, { question_ids }) {
      const rows = await myQuestions(ctx, question_ids);
      rows.sort((a, b) => question_ids.indexOf(a.id) - question_ids.indexOf(b.id));
      return fullSet(rows);
    },
  },
  {
    name: "search_questions",
    title: "Search questions",
    description: "Finds your questions whose question, options, explanation or topic note title contain some text (not case sensitive), optionally only inside one deck and its sub-decks. Returns the short form; up to 100.",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 2 }, deck_id: { ...id, description: "Only search inside this deck and its sub-decks." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 30 } }, required: ["text"] },
    annotations: { readOnlyHint: true },
    async run(ctx, { text, deck_id = null, limit = 30 }) {
      if (deck_id) await myDeck(ctx, deck_id);
      const term = String(text ?? "").trim().replace(/[%_\\]/g, m => "\\" + m);
      if (term.length < 2) throw new Error("Search for at least 2 characters.");
      const { data, error } = await ctx.db.rpc("my_question_search", { q: term, within: deck_id, lim: limit });
      if (error) throw new Error(error.message);
      return { found: data.length, questions: data.map(summary) };
    },
  },
  {
    name: "create_deck",
    title: "Create a deck",
    description: "Makes a new empty deck, at the top level or inside another deck, at the end of its siblings.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, parent_deck_id: { ...id, description: "Leave out for a top-level deck." } }, required: ["name"] },
    async run(ctx, { name, parent_deck_id = null }) {
      if (!String(name ?? "").trim()) throw new Error("A deck needs a name.");
      if (parent_deck_id) await myDeck(ctx, parent_deck_id);
      const siblings = (await myDecks(ctx)).filter(d => (d.parent_id ?? null) === parent_deck_id).sort(byOrder);
      const { position } = placeAmong(siblings);
      const { data, error } = await ctx.db.from("decks").insert({ owner_id: ctx.userId, name: name.trim(), parent_id: parent_deck_id, position }).select("id").single();
      if (error) throw new Error(error.message);
      return { created: { id: data.id, name: name.trim(), parent_deck_id } };
    },
  },
  {
    name: "update_deck",
    title: "Rename, move or reorder a deck",
    description: "Renames a deck, moves it into another deck (or to the top level), and/or places it before or after a sibling. Everything inside comes with it.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: id,
        name: { type: "string", description: "New name." },
        parent_deck_id: { type: ["string", "null"], description: "New parent deck id, or null for the top level. Leave out to keep the parent." },
        before_deck_id: { type: "string", description: "Put it just before this sibling." },
        after_deck_id: { type: "string", description: "Put it just after this sibling." },
      },
      required: ["deck_id"],
    },
    async run(ctx, { deck_id, name, parent_deck_id, before_deck_id, after_deck_id }) {
      const deck = await myDeck(ctx, deck_id);
      const patch = {};
      if (name !== undefined) {
        if (!String(name).trim()) throw new Error("A deck needs a name.");
        patch.name = String(name).trim();
      }
      const parent = parent_deck_id === undefined ? (deck.parent_id ?? null) : parent_deck_id;
      const moving = parent_deck_id !== undefined || before_deck_id || after_deck_id;
      if (moving) {
        const decks = await myDecks(ctx);
        if (parent && !decks.some(d => d.id === parent)) throw new Error("The new parent is not one of your decks.");
        if (parent && subtree(decks, deck_id).has(parent)) throw new Error("A deck cannot go inside itself.");
        const siblings = decks.filter(d => (d.parent_id ?? null) === parent && d.id !== deck_id).sort(byOrder);
        const { position, renumber } = placeAmong(siblings, { before: before_deck_id, after: after_deck_id });
        for (const r of renumber) {
          const { error } = await ctx.db.from("decks").update({ position: r.position }).eq("id", r.id);
          if (error) throw new Error(error.message);
        }
        patch.parent_id = parent;
        patch.position = position;
      }
      if (!Object.keys(patch).length) return { unchanged: true };
      const { error } = await ctx.db.from("decks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", deck_id);
      if (error) throw new Error(error.message);
      return { updated: { id: deck_id, ...patch } };
    },
  },
  {
    name: "delete_deck",
    title: "Delete an empty deck",
    description: "Deletes a deck that has no questions and no decks inside it. Move or delete its contents first.",
    inputSchema: { type: "object", properties: { deck_id: id }, required: ["deck_id"] },
    annotations: { destructiveHint: true },
    async run(ctx, { deck_id }) {
      const deck = await myDeck(ctx, deck_id);
      const decks = await myDecks(ctx);
      if (decks.some(d => d.parent_id === deck_id)) throw new Error("That deck has decks inside it. Move or delete them first.");
      const { count, error: cErr } = await ctx.db.from("generated_questions").select("id", { count: "exact", head: true }).eq("deck_id", deck_id);
      if (cErr) throw new Error(cErr.message);
      if (count) throw new Error(`That deck still has ${count} questions. Move or delete them first.`);
      const { error } = await ctx.db.from("decks").delete().eq("id", deck_id);
      if (error) throw new Error(error.message);
      return { deleted: { id: deck_id, name: deck.name } };
    },
  },
  {
    name: "add_questions",
    title: "Add questions",
    description: "Adds new questions to one of your decks. Each needs question, options, answer and explanation; why_wrong, topic_note and highlight_lines are optional.",
    inputSchema: { type: "object", properties: { deck_id: id, questions: { type: "array", items: questionShape, minItems: 1, maxItems: 100 } }, required: ["deck_id", "questions"] },
    async run(ctx, { deck_id, questions }) {
      await myDeck(ctx, deck_id);
      const rows = questions.map((q, i) => {
        try { return { user_id: ctx.userId, deck_id, payload: buildPayload(q) }; }
        catch (e) { throw new Error(`Question ${i + 1}: ${e.message}`, { cause: e }); }
      });
      const { data, error } = await ctx.db.from("generated_questions").insert(rows).select("id");
      if (error) throw new Error(error.message);
      return { added: data.map(r => r.id) };
    },
  },
  {
    name: "edit_questions",
    title: "Edit questions",
    description: "Changes parts of one or more questions (up to 100) in a single step. Only the fields you send change; every edit is checked before any is saved, so either all are saved or none. To show a picture already in Resurface, put a line '![caption](path)' in the explanation or topic note.",
    inputSchema: {
      type: "object",
      properties: { edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { question_id: qid, ...questionShape.properties }, required: ["question_id"] } } },
      required: ["edits"],
    },
    async run(ctx, { edits }) {
      const ids = edits.map(e => e.question_id);
      if (new Set(ids).size !== ids.length) throw new Error("Each question can only appear once; merge its changes into one edit.");
      const rows = new Map((await myQuestions(ctx, ids)).map(r => [r.id, r]));
      const out = edits.map(({ question_id, ...input }) => {
        const row = rows.get(question_id);
        try { return { id: question_id, user_id: ctx.userId, deck_id: row.deck_id, payload: buildPayload(input, row.payload) }; }
        catch (e) { throw new Error(`Question ${question_id}: ${e.message}`, { cause: e }); }
      });
      const { error } = await ctx.db.from("generated_questions").upsert(out, { onConflict: "id" });
      if (error) throw new Error(error.message);
      return { updated: out.length, questions: out.map(summary) };
    },
  },
  {
    name: "move_questions",
    title: "Move questions",
    description: "Moves questions into another of your decks.",
    inputSchema: { type: "object", properties: { question_ids: { type: "array", items: { type: "integer" }, minItems: 1 }, deck_id: id }, required: ["question_ids", "deck_id"] },
    async run(ctx, { question_ids, deck_id }) {
      await myDeck(ctx, deck_id);
      await myQuestions(ctx, question_ids);
      const { error } = await ctx.db.from("generated_questions").update({ deck_id }).in("id", question_ids).eq("user_id", ctx.userId);
      if (error) throw new Error(error.message);
      return { moved: question_ids.length, to: deck_id };
    },
  },
  {
    name: "delete_questions",
    title: "Delete questions",
    description: "Permanently deletes questions, and everyone's progress on them. Confirm with the person first.",
    inputSchema: { type: "object", properties: { question_ids: { type: "array", items: { type: "integer" }, minItems: 1 } }, required: ["question_ids"] },
    annotations: { destructiveHint: true },
    async run(ctx, { question_ids }) {
      await myQuestions(ctx, question_ids);
      const { error } = await ctx.db.from("generated_questions").delete().in("id", question_ids).eq("user_id", ctx.userId);
      if (error) throw new Error(error.message);
      return { deleted: question_ids.length };
    },
  },
  {
    name: "add_image",
    title: "Add a picture from a link",
    description: "Downloads a picture from a public https link (JPEG, PNG or WebP, up to 4 MB) and attaches it to a question: above the question, or as a figure in its explanation or topic note. Use only images the person chose. Pictures uploaded into this chat cannot be passed on; for those, use Add a picture in the app.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: qid,
        image_url: { type: "string", description: "A direct https link to the image file." },
        place: { type: "string", enum: ["question", "explanation", "topic_note"], description: "Where it shows." },
        caption: { type: "string", description: "Needed for explanation and topic_note." },
      },
      required: ["question_id", "image_url", "place"],
    },
    async run(ctx, { question_id, image_url, place, caption = "" }) {
      const [row] = await myQuestions(ctx, [question_id]);
      const path = await storeImage(ctx, image_url);
      const p = { ...row.payload };
      const fig = `![${String(caption).replace(/[[\]\n]/g, " ").trim() || "Figure"}](${path})`;
      if (place === "question") p.img = path;
      else if (place === "explanation") p.exp = `${p.exp ?? ""}\n\n${fig}`.trim();
      else if (place === "topic_note") {
        if (!p.topic) throw new Error("That question has no topic note to add a picture to.");
        p.topic = { ...p.topic, body: `${p.topic.body}\n\n${fig}` };
      } else throw new Error("place must be question, explanation or topic_note.");
      const { error } = await ctx.db.from("generated_questions").update({ payload: p }).eq("id", question_id);
      if (error) throw new Error(error.message);
      return { attached: path, place };
    },
  },
  {
    name: "set_deck_public",
    title: "Make a deck public or hide it",
    description: "Makes one of your top-level decks public to every student, or hides it again. Publishing needs every question in it approved in the Admin review, as on the Admin page. Tell the person before you do this.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: id,
        public: { type: "boolean" },
        byline: { type: "string", description: "Shown under the deck name, e.g. 'by Jacob'. Optional." },
      },
      required: ["deck_id", "public"],
    },
    annotations: { destructiveHint: true },
    async run(ctx, { deck_id, public: makePublic, byline }) {
      const deck = await myDeck(ctx, deck_id);
      if (deck.parent_id) throw new Error("Only a top-level deck can be made public. Move it to the top level first.");
      if (!makePublic) {
        const { error } = await ctx.db.rpc("admin_unfeature", { deck: deck_id });
        if (error) throw new Error(error.message);
        return { hidden: deck.name };
      }
      const status = await publicStatus(ctx);
      if (!status.has(deck_id) || byline !== undefined) {
        const { error } = await ctx.db.rpc("admin_set_featured", { deck: deck_id, p_byline: byline ?? "", p_folder: "", p_renames: {} });
        if (error) throw new Error(error.message);
      }
      const { error } = await ctx.db.rpc("admin_publish_featured", { deck: deck_id });
      if (error) throw new Error(error.message);
      return { public: deck.name };
    },
  },
];

/** Fetches an image the person pointed at and keeps a copy in their folder. */
async function storeImage(ctx, url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("That is not a valid link."); }
  if (u.protocol !== "https:") throw new Error("The image link must start with https://");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
    throw new Error("That link does not point at a public website.");
  }
  const res = await (ctx.fetch ?? fetch)(u, { redirect: "follow", headers: { "user-agent": "Resurface/1.0 (image import)" } });
  if (!res.ok) throw new Error(`The image could not be downloaded (${res.status}).`);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
  if (!ext) throw new Error(`That link is not a JPEG, PNG or WebP image (it is ${type || "unknown"}). Link to the image file itself.`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("That image is over 4 MB.");
  const path = `${ctx.userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await ctx.db.storage.from(IMAGE_BUCKET).upload(path, buf, { contentType: type, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

/** The tool set bound to one person's session. */
export function toolsFor(ctx) {
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  return {
    list: () => TOOLS.map(({ run: _run, ...def }) => def),
    has: name => byName.has(name),
    call: (name, args) => byName.get(name).run(ctx, args ?? {}),
  };
}
