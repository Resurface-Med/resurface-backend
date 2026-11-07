// The weekly team email: numbers in from the database (weekly_summary_data,
// migration 0072 in resurface-app), a plain HTML email out. Pure, so it is
// tested without sending anything.

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = n => Number(n ?? 0).toLocaleString("en-GB");

/** "+12 (34%)" / "−3 (8%)" / "same" against last week. */
export function change(now, prev) {
  const a = Number(now ?? 0), b = Number(prev ?? 0);
  if (a === b) return "same as last week";
  const diff = a - b;
  const sign = diff > 0 ? "+" : "−";
  const pct = b > 0 ? ` (${Math.round(Math.abs(diff) / b * 100)}%)` : "";
  return `${sign}${fmt(Math.abs(diff))}${pct} on last week`;
}

const day = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Things worth a look, worst first. Empty when the week was fine. */
export function flags(d) {
  const out = [];
  if (d.keepalive_age_hours == null || d.keepalive_age_hours > 30) out.push("The database keep-alive has not run for over a day. Supabase may pause the project and sign-in will stop working.");
  if (d.active_prev >= 5 && d.active < d.active_prev * 0.75) out.push(`Weekly active users fell by more than a quarter (${d.active_prev} to ${d.active}).`);
  if (d.signups >= 3 && d.signups_answered / d.signups < 0.6) out.push(`Only ${d.signups_answered} of ${d.signups} new sign-ups answered a question.`);
  if (d.reports > 0) out.push(`${d.reports} question report${d.reports === 1 ? "" : "s"} came in this week (${d.reports_open} open in total).`);
  return out;
}

export function subject(d) {
  return `Resurface weekly · ${day(d.from)} – ${day(d.to)}`;
}

/** Signed percentage change, or null when there is nothing to compare with. */
function pct(now, prev) {
  if (!prev) return null;
  return Math.round((Number(now) - Number(prev)) / Number(prev) * 100);
}

/** The opening sentences, in plain English. They carry what the figures
 *  below do not (sign-ups), rather than repeating them. */
export function lede(d) {
  const p = pct(d.active, d.active_prev);
  const first = p == null ? "" : p >= 10 ? "More students studied than last week. " : p <= -10 ? "Fewer students studied than last week. " : "About as many students studied as last week. ";
  const second = d.signups
    ? `${fmt(d.signups)} new ${d.signups === 1 ? "account was" : "accounts were"} created, and ${fmt(d.signups_answered)} of them answered at least one question.`
    : "No new accounts were created.";
  return first + second;
}

const INK = "#0f1b3d", SOFT = "#5a6485", FAINT = "#8a93ae", RULE = "#e6e9f0", UP = "#1a7f4b", DOWN = "#c0392b";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function delta(now, prev) {
  const p = pct(now, prev);
  if (p == null) return `<span style="color:${FAINT}">new</span>`;
  if (p === 0) return `<span style="color:${FAINT}">no change</span>`;
  return `<span style="color:${p > 0 ? UP : DOWN}">${p > 0 ? "▲" : "▼"} ${Math.abs(p)}%</span> <span style="color:${FAINT}">vs ${fmt(prev)}</span>`;
}

export function render(d) {
  const retention = d.active_prev ? Math.round(d.returned / d.active_prev * 100) : null;
  const kpi = (label, value, sub) => `
    <td valign="top" style="padding:0 16px 0 0;width:33%">
      <div style="font-size:13px;color:${SOFT}">${esc(label)}</div>
      <div style="font-size:30px;font-weight:600;color:${INK};line-height:1.2;margin-top:4px">${esc(value)}</div>
      <div style="font-size:12.5px;margin-top:4px">${sub}</div>
    </td>`;
  const th = (t, right) => `<th align="${right ? "right" : "left"}" style="font-size:12px;font-weight:500;color:${FAINT};padding:0 0 8px;border-bottom:1px solid ${RULE}">${t}</th>`;
  const td = (t, right, strong) => `<td align="${right ? "right" : "left"}" style="font-size:14px;color:${strong ? INK : SOFT};padding:10px 0;border-bottom:1px solid ${RULE}">${t}</td>`;
  const h2 = t => `<div style="font-size:16px;font-weight:600;color:${INK};margin:36px 0 12px">${t}</div>`;

  const decks = (d.decks || []).map(x => `<tr>${td(esc(x.deck), false, true)}${td(fmt(x.n), true)}${td(fmt(x.people), true)}${td(x.accuracy == null ? "–" : `${x.accuracy}%`, true)}</tr>`).join("");
  const ai = Object.entries(d.ai_calls || {}).map(([k, v]) => `${fmt(v)} ${k === "explain" ? "explanations" : k === "generate" ? "generations" : k}`).join(", ") || "none";
  const other = [
    ["Accuracy", d.accuracy == null ? "–" : `${d.accuracy}%`],
    ["Busiest day", d.busiest_day ? `${d.busiest_day.day}, ${fmt(d.busiest_day.answers)} answers` : "–"],
    ["Longest streak", `${fmt(d.longest_streak)} days`],
    ["Question reports", `${fmt(d.reports)} new, ${fmt(d.reports_open)} open`],
    ["Decks shared", fmt(d.shares)],
    ["Resurface AI", ai],
    ["Reminders on", fmt(d.reminders_on)],
    ["Accounts in total", fmt(d.users_total)],
  ].map(([k, v]) => `<tr>${td(esc(k))}${td(esc(v), true, true)}</tr>`).join("");
  const warn = flags(d);

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT};-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff"><tr><td align="center" style="padding:32px 20px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><img src="https://app.tryresurface.com/logo-lockup.png" alt="Resurface" height="26" style="display:block;height:26px;border:0"></td>
      <td align="right" style="font-size:13px;color:${FAINT}">${esc(day(d.from))} – ${esc(day(d.to))}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding-top:32px">
    <div style="font-size:22px;font-weight:600;color:${INK};line-height:1.3">Your week at Resurface</div>
    <p style="font-size:15px;line-height:1.6;color:${SOFT};margin:10px 0 0">${esc(lede(d))}</p>
  </td></tr>
  ${warn.length ? `<tr><td style="padding-top:20px;font-size:14px;line-height:1.6;color:${DOWN}">${warn.map(esc).join("<br>")}</td></tr>` : ""}
  <tr><td style="padding-top:32px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${kpi("Students", fmt(d.active), delta(d.active, d.active_prev))}
      ${kpi("Answers", fmt(d.answers), delta(d.answers, d.answers_prev))}
      ${kpi("Came back", retention == null ? "–" : `${retention}%`, `<span style="color:${FAINT}">${fmt(d.returned)} of ${fmt(d.active_prev)}</span>`)}
    </tr></table>
  </td></tr>
  ${decks ? `<tr><td>${h2("Decks")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>${th("Deck")}${th("Answers", true)}${th("Students", true)}${th("Accuracy", true)}</tr>${decks}
    </table></td></tr>` : ""}
  <tr><td>${h2("Also this week")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${other}</table>
  </td></tr>
  <tr><td style="padding-top:36px;font-size:12px;line-height:1.6;color:${FAINT}">Sent every Monday to Resurface admins. Weeks run Monday to Sunday.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function text(d) {
  const lines = [
    `Resurface, ${day(d.from)} – ${day(d.to)}`,
    ...flags(d).map(f => `! ${f}`),
    `Weekly active users: ${d.active} (${change(d.active, d.active_prev)})`,
    `New sign-ups: ${d.signups}, ${d.signups_answered} answered a question`,
    `Came back from last week: ${d.returned} of ${d.active_prev}`,
    `Questions answered: ${d.answers} (${change(d.answers, d.answers_prev)}), accuracy ${d.accuracy ?? "–"}%`,
    ...(d.decks || []).map(x => `  ${x.deck}: ${x.n} answers, ${x.people} people`),
    `Reports: ${d.reports} new, ${d.reports_open} open`,
  ];
  return lines.join("\n");
}
