// Who may use the Claude connector, and how they prove it.
//
// Claude signs people in through Supabase's own OAuth server (Authentication
// → OAuth Server), so the token it sends is an ordinary Supabase session token
// for that person. Supabase checks it; Postgres then applies the same row-level
// security as in the app.
//
// On top of that, only the user ids listed in MCP_USERS (comma-separated) get
// in. It is not advertised anywhere in the app; unset, nobody does.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://uhqpljteohitvytwfadp.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_0ZlQhc0Gn_bD5-AFIgPOrw_xKVHv8hJ";

/** Where Claude is sent to sign in: Supabase's OAuth 2.1 server. */
export const AUTH_SERVER = `${SUPABASE_URL}/auth/v1`;

export function allowedUsers() {
  return new Set((process.env.MCP_USERS || "").split(",").map(s => s.trim()).filter(Boolean));
}

/** The person behind a bearer token and a client acting as them, or null. */
export async function sessionFrom(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "").trim();
  if (!token) return null;
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db };
}

/** The URL of the connector itself, as Claude reached it. */
export function resourceUrl(req) {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || url.host;
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  return `${proto}://${host}/api/mcp`;
}

export function metadataUrl(req) {
  const r = new URL(resourceUrl(req));
  return `${r.origin}/.well-known/oauth-protected-resource${r.pathname}`;
}
