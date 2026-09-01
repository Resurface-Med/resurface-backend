// Keeps the database from falling asleep.
//
// Supabase pauses a free project after about a week without activity. When it
// does, the app does not degrade — it stops: signing in fails to fetch, and the
// dashboard waits forever on a session that will never resolve. Nothing in the
// logs says why, because the request never reaches anything that logs.
//
// One query a day resets the idle timer. The query is deliberately the smallest
// one that still reaches Postgres: RLS returns no rows to an anonymous caller,
// which is fine — the point is that the database was asked, not what it said.
//
// If this is ever removed, the pause comes back silently a week later.

import { anonClient } from "../../../lib/http.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  // Vercel sends this header on scheduled invocations when CRON_SECRET is set.
  // Unset, the route stays open — it reads nothing and returns nothing, so the
  // worst a stranger can do is keep the database awake, which is the job.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();

  try {
    const { error } = await anonClient()
      .from("profiles")
      .select("id", { count: "exact", head: true });

    // An RLS refusal still means Postgres answered, which is all this needs.
    // A transport failure does not, and that is the one worth shouting about.
    if (error && !error.code) throw new Error(error.message);

    return Response.json({ ok: true, ms: Date.now() - started });
  } catch (e) {
    console.error("[keepalive] database unreachable:", e.message);
    return Response.json({ ok: false, error: e.message }, { status: 503 });
  }
}
