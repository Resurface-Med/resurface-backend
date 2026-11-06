// The Claude connector (MCP over Streamable HTTP, stateless JSON).
//
// Not linked from the app and not announced; only the accounts in MCP_USERS
// get past the door. See lib/mcp/access.js for sign-in and lib/mcp/tools.js
// for what it can do.

import { allowedUsers, metadataUrl, sessionFrom } from "../../../lib/mcp/access.js";
import { handleBody } from "../../../lib/mcp/protocol.js";
import { toolsFor } from "../../../lib/mcp/tools.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(req) {
  return new Response(JSON.stringify({ error: "Sign in with Resurface first." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      // Tells Claude where to start the sign-in (RFC 9728).
      "www-authenticate": `Bearer resource_metadata="${metadataUrl(req)}"`,
    },
  });
}

export async function POST(req) {
  const session = await sessionFrom(req);
  if (!session) return unauthorized(req);
  if (!allowedUsers().has(session.userId)) {
    return Response.json({ error: "This connector is not available for your account." }, { status: 403 });
  }

  let body;
  try { body = await req.json(); }
  catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }

  const out = await handleBody(body, toolsFor(session));
  if (out === null) return new Response(null, { status: 202 });
  return Response.json(out);
}

// No server-to-client stream: every answer comes back on its POST.
export async function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
