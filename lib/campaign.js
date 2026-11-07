// Mailing-list emails. The database (mailing_list_send, migration 0075 in
// resurface-app) sorts the opted-in list into three groups and posts it to
// /api/campaign/send; this holds the words for each group and the layout.
// Pure, so it is tested without sending anything.

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const APP = "https://app.tryresurface.com";

/** Each campaign: one email per group. Paragraphs are plain text; `button`
 *  is optional and sits after `beforeButton` paragraphs. */
export const CAMPAIGNS = {
  intro: {
    regular: {
      subject: "Thank you for using Resurface",
      paragraphs: [
        "Rafil here, I made Resurface. I just wanted to say thank you. You're one of the people using it most consistently, and that means a lot this early on.",
        "Keep going. A few questions a day adds up faster than you'd think by exam time.",
        "One favour: if anything's missing, wrong or annoying, reply and tell me. The people who use it most shape what we build next.",
        "And if your friends are still revising the old-fashioned way, send them tryresurface.com.",
      ],
      button: { label: "Open Resurface", url: APP }, beforeButton: 2,
    },
    nudge: {
      subject: "Pick up where you left off",
      paragraphs: [
        "Rafil here, I made Resurface. Thanks for giving it a go.",
        "The people getting the most out of it aren't doing hours. They do 10 questions most days, which is about five minutes on the bus or before a lecture. Your progress is saved, so you can carry on where you left off.",
        "Year 1 has Principles, Respiratory and Gastrointestinal. Year 2 has Renal, Endocrine and the new MSK deck.",
        "If something put you off, reply and tell me. I'd genuinely like to know.",
      ],
      button: { label: "Do 10 questions", url: APP }, beforeButton: 3,
    },
    never: {
      subject: "Your lectures, as exam questions",
      paragraphs: [
        "Rafil here, I'm a med student at ARU and I made Resurface. Thanks for signing up.",
        "It's questions written from our actual lectures, in our exam style, with an explanation and a short revision note for every one. Nearly 60 people from our med school are already using it.",
        "The easiest way to see if it's for you: open it, tap your year's deck, and do 10 questions. About five minutes.",
        "It's free. If anything's confusing, just reply.",
      ],
      button: { label: "Do 10 questions", url: APP }, beforeButton: 3,
    },
  },
};

const INK = "#0f1b3d", SOFT = "#3d4766", FAINT = "#8a93ae", ACCENT = "#3562f5";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function render(email, unsubscribe) {
  const p = t => `<p style="font-size:16px;line-height:1.65;color:${SOFT};margin:0 0 18px">${esc(t)}</p>`;
  const button = email.button ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 26px"><tr>
      <td style="border-radius:999px;background:${ACCENT}">
        <a href="${esc(email.button.url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px">${esc(email.button.label)}</a>
      </td>
    </tr></table>` : "";
  const at = email.beforeButton ?? email.paragraphs.length;
  const body = email.paragraphs.slice(0, at).map(p).join("") + button + email.paragraphs.slice(at).map(p).join("");

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT};-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:36px 22px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px"><tr><td>
  <img src="${APP}/logo-lockup.png" alt="Resurface" height="26" style="display:block;height:26px;border:0;margin-bottom:34px">
  <p style="font-size:16px;line-height:1.65;color:${INK};margin:0 0 18px">Hey,</p>
  ${body}
  <p style="font-size:16px;line-height:1.65;color:${INK};margin:4px 0 0">Rafil</p>
  <p style="font-size:12px;line-height:1.6;color:${FAINT};margin:40px 0 0">You're getting this because you asked for updates when you signed up. <a href="${esc(unsubscribe)}" style="color:${FAINT};text-decoration:underline">Unsubscribe</a></p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

export function text(email, unsubscribe) {
  const lines = ["Hey,", "", ...email.paragraphs.flatMap((t, i) =>
    i === (email.beforeButton ?? -1) - 1 && email.button ? [t, "", `${email.button.label}: ${email.button.url}`, ""] : [t, ""]),
    "Rafil", "", `Unsubscribe: ${unsubscribe}`];
  return lines.join("\n");
}
