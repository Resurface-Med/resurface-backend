// OAuth protected-resource metadata for the Claude connector (RFC 9728).
// Served at /.well-known/oauth-protected-resource[/api/mcp] by a rewrite in
// next.config.mjs. It tells Claude which server signs people in: Supabase's.

import { AUTH_SERVER, resourceUrl } from "../../../lib/mcp/access.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  return Response.json({
    resource: resourceUrl(req),
    authorization_servers: [AUTH_SERVER],
    bearer_methods_supported: ["header"],
    resource_name: "Resurface",
  }, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}
