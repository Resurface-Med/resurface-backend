// One-click unsubscribe from the mailing list. The link in every email is
// /api/unsubscribe?u=<user id>&t=<token>; the token is checked in Postgres
// (marketing_unsubscribe, migration 0075 in resurface-app), which is also
// the only thing it can change: that person's marketing_opt_in, to false.
//
// GET is a person clicking the link; POST is Gmail's one-click unsubscribe
// (RFC 8058), which posts to the same address.
import { anonClient } from "../../../lib/http.js";

export const dynamic = "force-dynamic";

async function unsubscribe(req) {
  const url = new URL(req.url);
  const u = url.searchParams.get("u"), t = url.searchParams.get("t");
  if (!u || !t || !/^[0-9a-f-]{36}$/i.test(u)) return false;
  const { data, error } = await anonClient().rpc("marketing_unsubscribe", { u, t });
  return !error && data === true;
}

const page = ok => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resurface</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#0f1b3d">
<div style="max-width:440px;margin:0 auto;padding:72px 24px;text-align:center">
<img src="https://app.tryresurface.com/logo-lockup.png" alt="Resurface" height="28" style="height:28px">
<h1 style="font-size:21px;font-weight:600;margin:36px 0 10px">${ok ? "You're unsubscribed" : "That link didn't work"}</h1>
<p style="font-size:16px;line-height:1.6;color:#5a6485;margin:0">${ok ? "You won't get any more update emails from Resurface. Your account and progress are untouched." : "Reply to any of our emails and we'll take you off the list by hand."}</p>
</div></body></html>`, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });

export async function GET(req) { return page(await unsubscribe(req)); }
export async function POST(req) { const ok = await unsubscribe(req); return new Response(null, { status: ok ? 200 : 400 }); }
