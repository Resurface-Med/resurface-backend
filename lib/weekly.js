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
  return `Resurface week ${day(d.from)} – ${day(d.to)}: ${fmt(d.active)} active, ${fmt(d.answers)} answers`;
}

export function render(d) {
  const row = (label, value, note) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;color:#555">${esc(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#111">${esc(value)}</td>
    </tr>${note ? `<tr><td colspan="2" style="padding:0 0 10px;color:#888;font-size:13px;border-bottom:1px solid #eee">${esc(note)}</td></tr>` : ""}`;
  const retention = d.active_prev ? `${Math.round(d.returned / d.active_prev * 100)}%` : "–";
  const decks = (d.decks || []).map(x => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;color:#111">${esc(x.deck)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;text-align:right;color:#555">${fmt(x.n)} answers · ${fmt(x.people)} people · ${esc(x.accuracy)}%</td>
    </tr>`).join("");
  const ai = Object.entries(d.ai_calls || {}).map(([k, v]) => `${fmt(v)} ${k}`).join(", ") || "none";
  const warn = flags(d);
  const h = t => `<h2 style="font-size:15px;font-weight:600;margin:28px 0 6px;color:#111">${t}</h2>`;

  return `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px">
    <div style="background:#fff;border-radius:14px;padding:28px 26px">
      <div style="color:#888;font-size:13px">${esc(day(d.from))} – ${esc(day(d.to))}</div>
      <h1 style="font-size:22px;font-weight:600;margin:4px 0 0;color:#111">How Resurface went this week</h1>
      ${warn.length ? `<div style="margin-top:20px;padding:14px 16px;border-radius:10px;background:#fff6e6;color:#7a4b00;font-size:14px;line-height:1.5">${warn.map(esc).join("<br>")}</div>` : ""}
      ${h("People")}
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        ${row("Weekly active users", fmt(d.active), change(d.active, d.active_prev))}
        ${row("New sign-ups", fmt(d.signups), `${fmt(d.signups_answered)} of them answered a question · ${change(d.signups, d.signups_prev)}`)}
        ${row("Came back from last week", retention, `${fmt(d.returned)} of last week's ${fmt(d.active_prev)}`)}
        ${row("Accounts in total", fmt(d.users_total))}
      </table>
      ${h("Studying")}
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        ${row("Questions answered", fmt(d.answers), change(d.answers, d.answers_prev))}
        ${row("Accuracy", d.accuracy == null ? "–" : `${d.accuracy}%`)}
        ${row("Busiest day", d.busiest_day ? `${d.busiest_day.day}` : "–", d.busiest_day ? `${fmt(d.busiest_day.answers)} answers` : "")}
        ${row("Top five students answered", (d.top_users_answers || []).map(fmt).join(", ") || "–")}
        ${row("Longest current streak", `${fmt(d.longest_streak)} days`)}
      </table>
      ${decks ? `${h("Decks")}<table style="width:100%;border-collapse:collapse;font-size:14px">${decks}</table>` : ""}
      ${h("Everything else")}
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        ${row("Question reports", fmt(d.reports), `${fmt(d.reports_open)} open`)}
        ${row("Decks shared", fmt(d.shares))}
        ${row("AI calls", ai)}
        ${row("Study reminders switched on", fmt(d.reminders_on))}
      </table>
    </div>
    <div style="color:#999;font-size:12px;text-align:center;margin-top:16px">Sent every Monday to Resurface admins.</div>
  </div></body></html>`;
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
