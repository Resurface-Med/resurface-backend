// The Model Context Protocol, the small part of it Claude needs to use Resurface
// as a connector.
//
// Claude speaks JSON-RPC to one URL (Streamable HTTP). Everything here is
// stateless: each POST is answered on its own with plain JSON, never a stream,
// which the spec allows and which suits a serverless function that may be a
// different instance every time. There are no resources or prompts, only tools.
//
// Kept free of Next and Supabase so the dispatch can be tested on its own.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const SERVER_INFO = {
  name: "resurface", title: "Resurface", version: "1.0.0",
  // Opaque on purpose: the app icon's see-through corners showed as black
  // squares in Claude's connector list.
  icons: [{ src: "https://api.tryresurface.com/icon.png", mimeType: "image/png", sizes: ["512x512"] }],
  websiteUrl: "https://app.tryresurface.com",
};

export const INSTRUCTIONS = `Resurface is a question bank for medical students. These tools act on the signed-in person's own decks.
Decks nest: a deck can hold questions and other decks. Questions are multiple choice, with an explanation, a short "why" for each wrong option, and an optional topic note.
Working well:
- Find before you change: list_decks for deck ids, search_questions to find questions by their words, get_deck for a deck's short list, get_questions for full text. Use real ids; never guess one.
- Before writing or rewriting any question or topic note, call get_question_style once and follow it exactly. A topic note opens with one plain sentence that breaks the topic down simply, then **Heading** sections, one ==highlight==, and a closing **Where marks are lost**. For questions: five terse options, one question line ending in "?", a two-sentence explanation and a why_wrong for every wrong option. The server refuses questions that break it and says what to fix.
- Write less, it is what makes you slow: a topic note shared by several questions goes once in the call's notes object, and each question gives only its key. Send only fields that change. If some items are refused, the rest are already saved: resend only the refused ones.
- Batch. edit_questions takes up to 100 edits and add_questions up to 100 questions in one call; send one call for a whole set rather than one per question. Send only the fields that change.
- A topic note is {"title", "body"}. The body uses **Heading** lines, "- " points and at most one ==highlight==. highlight_lines are lines from that note, copied as they appear.
- If a call fails, read the message: it says what to fix. Fix that and retry once; do not loop.
When a change affects a deck that is public, say so to the person before you make it. Never invent medical content the person did not ask for.`;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

/**
 * Answers one JSON-RPC message. Returns null for a notification, which gets
 * no reply. `tools` is { list(): defs, call(name, args): Promise<result> }.
 */
export async function handleMessage(msg, tools) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: tools.list() });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (!tools.has(name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const out = await tools.call(name, args);
        return rpcResult(msg.id, {
          content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }],
        });
      } catch (e) {
        // A tool that fails tells Claude why, as a result it can read and act
        // on, rather than a protocol error it can only report.
        return rpcResult(msg.id, { content: [{ type: "text", text: e?.message || String(e) }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** A body may be one message or a batch. Returns what to send, or null for 202. */
export async function handleBody(body, tools) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handleMessage(m, tools)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMessage(body, tools);
}
