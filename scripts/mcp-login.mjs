// Signs in to the Claude connector the way Claude does, for testing it end to
// end: registers a client with Supabase's OAuth server, opens the consent
// page, catches the code on localhost and swaps it for a token.
//
//   node scripts/mcp-login.mjs <token-file>
//
// Prints the address to open; whoever is signed in to Resurface in that
// browser presses Allow. The token is written to <token-file> (never printed).

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) { console.error("usage: node scripts/mcp-login.mjs <token-file>"); process.exit(1); }

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const b64 = buf => buf.toString("base64url");

const meta = await (await fetch("https://uhqpljteohitvytwfadp.supabase.co/.well-known/oauth-authorization-server/auth/v1")).json();
const reg = await fetch(meta.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Resurface connector test",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const client = await reg.json();
if (!reg.ok) { console.error("registration failed", reg.status, client); process.exit(1); }

const verifier = b64(randomBytes(32));
const challenge = b64(createHash("sha256").update(verifier).digest());
const state = b64(randomBytes(12));
const url = new URL(meta.authorization_endpoint);
url.search = new URLSearchParams({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
  code_challenge: challenge, code_challenge_method: "S256", state,
}).toString();
console.log(`OPEN ${url}`);

const code = await new Promise((resolve, reject) => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== "/callback") { res.end(); return; }
    res.end("Signed in. You can close this tab.");
    srv.close();
    if (u.searchParams.get("state") !== state) reject(new Error("state mismatch"));
    else if (u.searchParams.get("error")) reject(new Error(u.searchParams.get("error")));
    else resolve(u.searchParams.get("code"));
  }).listen(PORT);
  setTimeout(() => { srv.close(); reject(new Error("timed out waiting for Allow")); }, 10 * 60 * 1000);
});

const tok = await fetch(meta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }),
});
const t = await tok.json();
if (!tok.ok || !t.access_token) { console.error("token exchange failed", tok.status, Object.keys(t)); process.exit(1); }
writeFileSync(out, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, client_id: client.client_id }), { mode: 0o600 });
console.log("TOKEN SAVED", Object.keys(t).join(","));
process.exit(0);
