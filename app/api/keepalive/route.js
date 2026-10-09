// Keeps the database from falling asleep, and records that it did.
//
// Supabase pauses a free project after about a week without activity. When it
// does, the app does not degrade — it stops: signing in fails to fetch, and the
// dashboard waits forever on a session that will never resolve. Nothing in the
// logs says why, because the request never reaches anything that logs.
//
// One query a day resets the idle timer. It goes through keepalive_ping(),
// which touches Postgres — the entire point — and stamps a row in
// ops_heartbeat on the way past.
//
// That stamp is the difference between a cron you trust and one you hope
// about. This route can fail the same silent way the pause does: a 401 every
// morning if CRON_SECRET is ever wrong, nothing visibly broken, and the pause
// arriving on schedule anyway. Hobby keeps runtime logs for one hour and this
// runs at 06:00, so the logs are gone before anybody looks. The timestamp is
// not. Read it with admin_heartbeats(), or select it directly; if it is more
// than about a day old, the cron has stopped and the clock is ticking.
//
// If this is ever removed, the pause comes back silently a week later.

import { anonClient } from "../../../lib/http.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  // Vercel sends this header on scheduled invocations when CRON_SECRET is set.
  // Unset, the route stays open. It reads nothing and the only thing it writes
  // is a timestamp it chooses itself, so the worst a stranger can do is keep
  // the database awake and move that stamp forward, which is the job.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();

  try {
    const { data, error } = await anonClient().rpc("keepalive_ping");

    // An RLS refusal still means Postgres answered, which is all this needs.
    // A transport failure does not, and that is the one worth shouting about.
    if (error && !error.code) throw new Error(error.message);

    // Returned so a human calling this by hand can see the stamp move, and so
    // a failure to write it is visible rather than assumed.
    return Response.json({ ok: true, ms: Date.now() - started, at: data ?? null });
  } catch (e) {
    console.error("[keepalive] database unreachable:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 503 });
  }
}
