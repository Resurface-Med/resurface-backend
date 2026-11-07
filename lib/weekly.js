// The weekly team email. The database works out the week's business numbers
// (weekly_business_data, migration 0072 in resurface-app); Gemini turns them
// into a short note in plain words: the main thing, growth, whether people are
// sticking, what to watch and what to do next. A few key figures follow.
//
// Nothing here is about how well students score. That is their revision; this
// is about whether Resurface is growing and keeping people.

import { callGemini, parseJson } from "./gemini.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = n => Number(n ?? 0).toLocaleString("en-GB");
const day = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export const SYSTEM = `You write the weekly update email for the three student founders of Resurface: Rafil, Jacob and Rayan.

About Resurface: a free revision app for UK medical students (MBChB at Anglia Ruskin, Year 1 and Year 2 so far). Students answer exam-style questions from ready-made decks the founders build, or from their own lectures. It has no revenue yet; it grows by word of mouth between students. The founders care about growth, whether new sign-ups actually start using it, whether people come back (stickiness), and what to do next.

You are given one week of numbers as JSON (staff accounts are excluded). Write like a sharp, friendly operator at a small startup writing to their co-founders:
- Plain, simple English. Short sentences. No jargon (say "came back", not "retention cohort"). No hype, no exclamation marks, no emoji.
- Lead with the one thing that matters most this week.
- Use numbers sparingly, only to make a point. Write counts as digits (32, not thirty-two); "about a third" style fractions are fine.
- Explain any ratio in everyday words: say "on a typical day, 4 in 10 of this week's students studied", never "stickiness" or "DAU/WAU".
- Never comment on how well students answer questions; that is their revision, not a business number.
- Only claim what the numbers show. If you suggest a reason, say it is a guess. Do not invent exams, dates, events or features.
- The 8-week trend starts when tracking began; do not treat it as a full history.
- Word of mouth cannot be measured: most students share the tryresurface.com link directly (group chats, messages), which is not tracked. decks_shared and invites_shared only count the in-app share buttons. Never conclude that word of mouth is weak or not spreading from them; treat new sign-ups as the sign of word of mouth.
- Next steps must be concrete things three students could do this week (who to message, what to fix or test, what to build or stop), each one sentence, tied to a number in the data.

Return JSON only, in exactly this shape:
{"headline": "one sentence, the main thing",
 "main": "two or three sentences expanding the headline",
 "growth": "two to four sentences on new sign-ups and whether they started using it",
 "sticking": "two to four sentences on whether people keep coming back and how often",
 "watch": "one to three sentences on anything worrying, or an empty string if nothing is",
 "next": ["two or three next steps"]}`;

export const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" }, main: { type: "string" }, growth: { type: "string" },
    sticking: { type: "string" }, watch: { type: "string" },
    next: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "main", "growth", "sticking", "watch", "next"],
};

/** The week, trimmed of the empty weeks before tracking began. */
export function forModel(d) {
  const trend = [...(d.weekly_active_last_8_weeks_oldest_first || [])];
  while (trend.length && !trend[0]) trend.shift();
  return { ...d, weekly_active_last_8_weeks_oldest_first: trend };
}

/** The note, from Gemini; a plain fallback written from the numbers if it fails. */
export async function writeNote(d, apiKey) {
  const models = [process.env.WEEKLY_MODEL || "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  for (const model of apiKey ? models : []) {
    const r = await callGemini({
      apiKey, model, system: SYSTEM, schema: SCHEMA, timeoutMs: 45_000,
      input: [{ type: "text", text: JSON.stringify(forModel(d)) }],
    });
    const note = r.ok ? parseJson(r.text) : null;
    if (note?.headline && Array.isArray(note.next)) return { ...note, by: model };
    console.log(`weekly note: ${model} failed`, r.ok ? "bad JSON" : `${r.status} ${r.message ?? ""}`);
  }
  return fallbackNote(d);
}

export function fallbackNote(d) {
  const back = d.weekly_active_prev ? Math.round(d.retained_from_last_week / d.weekly_active_prev * 100) : null;
  return {
    headline: `${fmt(d.weekly_active)} students used Resurface this week, against ${fmt(d.weekly_active_prev)} the week before.`,
    main: `${fmt(d.signups)} people signed up and ${fmt(d.signups_studied)} of them answered at least one question.`,
    growth: "",
    sticking: back == null ? "" : `${back}% of last week's students came back this week.`,
    watch: "",
    next: [],
    by: null,
  };
}

/** The figures under the note: the ones a startup watches, in plain labels. */
export function keyFigures(d) {
  const pctOf = (a, b) => (b ? `${Math.round(a / b * 100)}%` : "–");
  const change = (a, b) => (b ? ` (${a >= b ? "+" : "−"}${Math.abs(Math.round((a - b) / b * 100))}%)` : "");
  return [
    ["Students this week", `${fmt(d.weekly_active)}${change(d.weekly_active, d.weekly_active_prev)}`],
    ["New sign-ups", `${fmt(d.signups)}${change(d.signups, d.signups_prev)}`],
    ["Sign-ups who started studying", pctOf(d.signups_studied, d.signups)],
    ["Last week's students who came back", pctOf(d.retained_from_last_week, d.weekly_active_prev)],
    ["Studied on 4 or more days", `${fmt(d.students_4plus_days)} of ${fmt(d.weekly_active)}`],
    ["Daily users as a share of weekly", d.stickiness_dau_over_wau_pct == null ? "–" : `${d.stickiness_dau_over_wau_pct}%`],
    ["Total accounts", fmt(d.accounts_total)],
  ];
}

export function subject(d, note) {
  return `Resurface this week: ${note?.headline || `${fmt(d.weekly_active)} students`}`.slice(0, 140);
}

const INK = "#0f1b3d", SOFT = "#4a5578", FAINT = "#8a93ae", RULE = "#e6e9f0";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function render(d, note) {
  const para = (title, body) => body ? `
    <div style="font-size:15px;font-weight:600;color:${INK};margin:26px 0 6px">${esc(title)}</div>
    <p style="font-size:15px;line-height:1.65;color:${SOFT};margin:0">${esc(body)}</p>` : "";
  const next = (note.next || []).filter(Boolean);
  const figures = keyFigures(d).map(([k, v]) => `<tr>
      <td style="font-size:14px;color:${SOFT};padding:9px 0;border-bottom:1px solid ${RULE}">${esc(k)}</td>
      <td align="right" style="font-size:14px;color:${INK};font-weight:600;padding:9px 0;border-bottom:1px solid ${RULE}">${esc(v)}</td>
    </tr>`).join("");

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT};-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 20px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="https://app.tryresurface.com/logo-lockup.png" alt="Resurface" height="26" style="display:block;height:26px;border:0"></td>
    <td align="right" style="font-size:13px;color:${FAINT}">${esc(day(d.week.from))} – ${esc(day(d.week.to))}</td>
  </tr></table>
  <div style="font-size:21px;font-weight:600;color:${INK};line-height:1.35;margin-top:30px">${esc(note.headline)}</div>
  <p style="font-size:15px;line-height:1.65;color:${SOFT};margin:12px 0 0">${esc(note.main)}</p>
  ${para("Growth", note.growth)}
  ${para("Are people sticking?", note.sticking)}
  ${para("Worth watching", note.watch)}
  ${next.length ? `<div style="font-size:15px;font-weight:600;color:${INK};margin:26px 0 6px">What to do this week</div>
    <ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.65;color:${SOFT}">${next.map(n => `<li style="margin-bottom:6px">${esc(n)}</li>`).join("")}</ol>` : ""}
  <div style="font-size:15px;font-weight:600;color:${INK};margin:32px 0 6px">The numbers</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${figures}</table>
  <p style="font-size:12px;line-height:1.6;color:${FAINT};margin:28px 0 0">Sent every Friday at 9am to the Resurface team. Covers the seven days up to Thursday and leaves out our own accounts.${note.by ? "" : " The written summary could not be generated this week, so only the basics are shown."}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

export function text(d, note) {
  return [
    note.headline, "", note.main,
    note.growth && `\nGrowth\n${note.growth}`,
    note.sticking && `\nAre people sticking?\n${note.sticking}`,
    note.watch && `\nWorth watching\n${note.watch}`,
    (note.next || []).length && `\nWhat to do this week\n${note.next.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    "\nThe numbers", ...keyFigures(d).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean).join("\n");
}
