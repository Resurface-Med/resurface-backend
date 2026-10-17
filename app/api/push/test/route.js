// "Send a test notification" from Profile: to the device that asked, now.
// Signed-in only; the device's own subscription comes in the body, so this
// reads nothing from the database.
import { allowedOrigin, json, preflight, verify } from "../../../../lib/http.js";
import { sendPush, validSubscription } from "../../../../lib/push.js";

export async function OPTIONS(req) {
  return preflight(req);
}

export async function POST(req) {
  const origin = allowedOrigin(req.headers.get("origin"));
  const user = await verify(req);
  if (!user) return json({ error: "Sign in first." }, 401, origin);
  const body = await req.json().catch(() => null);
  if (!validSubscription(body?.subscription)) return json({ error: "No device to send to." }, 400, origin);
  const r = await sendPush(body.subscription, {
    title: "Resurface",
    body: "Notifications are working. This is what a reminder will look like.",
    url: "/",
  });
  if (!r.ok) return json({ error: r.gone ? "This device is no longer subscribed. Turn reminders off and on again." : "Could not send it." }, 502, origin);
  return json({ ok: true }, 200, origin);
}
