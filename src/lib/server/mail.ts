/**
 * Transactional email through Brevo's REST API (free tier: 300 emails a day), used for the weekly digest
 * and subscription confirmations. Without BREVO_API_KEY nothing is sent and callers are told so; the
 * site never fails because mail is not set up.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function mailConfigured(): boolean {
  return Boolean(process.env.BREVO_API_KEY);
}

export async function sendMail(m: Mail): Promise<boolean> {
  const key = process.env.BREVO_API_KEY;
  if (!key) return false;
  const from = process.env.MAIL_FROM ?? "GhanaWatch <alerts@ghanawatch.gh>";
  const match = from.match(/^(.*?)\s*<(.+)>$/);
  const sender = match ? { name: match[1].trim() || "GhanaWatch", email: match[2] } : { name: "GhanaWatch", email: from };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html ?? `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(m.text)}</pre>` }),
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
