// The weekly team email. Every Monday at 9am the database (weekly_summary_tick,
// migration 0072 in resurface-app) posts the week's business numbers and the
// admins' addresses here; Gemini writes the note, and Resend sends it.
//
// Guarded by PUSH_SECRET, the same secret the study reminders use, already
// in both Vercel and the database vault. RESEND_API_KEY is a send-only key
// made for this alone, so it can be revoked without touching sign-in email.
import { render, subject, text, writeNote } from "../../../../lib/weekly.js";

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
  const to = Array.isArray(body?.to) ? body.to.filter(e => typeof e === "string" && e.includes("@")).slice(0, 10) : [];
  const d = body?.data;
  if (!to.length || !d?.week) return Response.json({ error: "Nothing to send" }, { status: 400 });

  const note = await writeNote(d, process.env.GEMINI_API_KEY);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: process.env.WEEKLY_FROM || "Resurface <weekly@tryresurface.com>",
      to,
      subject: subject(d, note),
      html: render(d, note),
      text: text(d, note),
    }),
  });
  const out = await r.json().catch(() => ({}));
  console.log(`weekly summary: ${r.status} to ${to.length}, note by ${note.by ?? "fallback"}`, r.ok ? out.id : JSON.stringify(out));
  return Response.json({ ok: r.ok, status: r.status, note_by: note.by, resend: out }, { status: r.ok ? 200 : 502 });
}
