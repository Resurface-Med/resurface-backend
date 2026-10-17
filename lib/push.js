/**
 * Sending web-push notifications (2026-10-17, experimental).
 *
 * The browser gives the app a private address for each device (Apple's,
 * Google's or Mozilla's push service); a notification is a small payload
 * posted there, signed with our VAPID key so only we can send to it. The
 * app's service worker shows it — the app need not be open.
 *
 * Keys: VAPID_PUBLIC_KEY (also in the app, which is fine — it is public),
 * VAPID_PRIVATE_KEY, VAPID_SUBJECT.
 */
import webpush from "web-push";

let ready = false;
function setup() {
  if (ready) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "https://tryresurface.com", pub, priv);
  ready = true;
  return true;
}

/** A subscription as the browser gives it: { endpoint, keys: { p256dh, auth } }. */
export function validSubscription(s) {
  return Boolean(s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://")
    && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string");
}

/**
 * Sends one. Resolves to { ok, gone } — gone when the address no longer
 * exists (unsubscribed, app removed), so the caller can forget it.
 */
export async function sendPush(subscription, payload) {
  if (!setup()) return { ok: false, gone: false, error: "Notifications are not set up on the server." };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 * 6, urgency: "normal" });
    return { ok: true, gone: false };
  } catch (e) {
    const gone = e?.statusCode === 404 || e?.statusCode === 410;
    return { ok: false, gone, error: e?.body || e?.message || "Push failed" };
  }
}
