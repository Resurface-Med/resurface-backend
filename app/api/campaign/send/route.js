// Mailing-list sends. The database (mailing_list_send, migration 0075 in
// resurface-app) posts the opted-in list, each person tagged with their
// group and their own unsubscribe link; this picks the email for each group
// from lib/campaign.js and sends through Resend's batch endpoint, with the
// List-Unsubscribe headers Gmail and Apple Mail use for one-click unsubscribe.
//
// Guarded by PUSH_SECRET, like the reminders and the weekly email.
import { CAMPAIGNS, render, text } from "../../../../lib/campaign.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  const secret = process.env.PUSH_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) return Response.json({ error: "RESEND_API_KEY is not set" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const campaign = CAMPAIGNS[body?.campaign];
  const people = Array.isArray(body?.people) ? body.people : [];
  if (!campaign || !people.length) return Response.json({ error: "Nothing to send" }, { status: 400 });

  const emails = people
    .filter(p => typeof p?.email === "string" && p.email.includes("@") && campaign[p.group] && typeof p.unsubscribe === "string")
    .map(p => {
      const e = campaign[p.group];
      return {
        from: process.env.MAILING_FROM || "Rafil from Resurface <hello@tryresurface.com>",
        reply_to: "hello@tryresurface.com",
        to: [p.email],
        subject: (body.test ? `[test: ${p.group}] ` : "") + e.subject,
        html: render(e, p.unsubscribe),
        text: text(e, p.unsubscribe),
        headers: {
          "List-Unsubscribe": `<${p.unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });

  const sent = [], failed = [];
  for (let i = 0; i < emails.length; i += 100) {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(emails.slice(i, i + 100)),
    });
    const out = await r.json().catch(() => ({}));
    if (r.ok) sent.push(...(out.data || []).map(x => x.id));
    else failed.push(out);
  }
  const groups = people.reduce((m, p) => ({ ...m, [p.group]: (m[p.group] || 0) + 1 }), {});
  console.log(`campaign ${body.campaign}${body.test ? " (test)" : ""}: ${sent.length} sent`, JSON.stringify(groups), failed.length ? JSON.stringify(failed) : "");
  return Response.json({ sent: sent.length, groups, failed }, { status: failed.length ? 502 : 200 });
}
