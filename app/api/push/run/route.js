// The reminders themselves. The database works out every 15 minutes who is
// at their reminder time with questions due (push_reminders_tick, migration
// 0011) and posts the list here; this only signs and delivers. It answers
// with the addresses that no longer exist, which the database then drops.
//
// Guarded by PUSH_SECRET, shared with the database's vault. Without it the
// route refuses everything.
import { sendPush, validSubscription } from "../../../../lib/push.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const secret = process.env.PUSH_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
  let sent = 0;
  const gone = [];
  await Promise.all(items.map(async it => {
    if (!validSubscription(it?.subscription)) return;
    const r = await sendPush(it.subscription, {
      title: String(it.title || "Resurface").slice(0, 80),
      body: String(it.body || "").slice(0, 200),
      url: "/?view=study",
      badge: Number.isFinite(it.badge) ? it.badge : undefined,
    });
    if (r.ok) sent += 1;
    else if (r.gone) gone.push(it.subscription.endpoint);
  }));
  console.log(`push run: ${items.length} asked, ${sent} sent, ${gone.length} gone`);
  return Response.json({ sent, gone });
}
