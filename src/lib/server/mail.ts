import { createHash } from "node:crypto";
import { rateLimit } from "./http";

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

/** Escapes text for HTML or XML, element content and quoted attribute values alike. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Characters XML 1.0 forbids anywhere in a document (C0 controls other than tab and newlines, lone surrogates, U+FFFE/U+FFFF). */
export function stripXmlInvalid(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** Confirmation emails per address per day, and in all per day (the Brevo free tier sends 300 a day, digest included). */
export const CONFIRMATION_MAILS_PER_ADDRESS = 3;
export const CONFIRMATION_MAILS_PER_DAY = 150;

/**
 * Whether one more subscription-confirmation email may go out to this address. Anyone can type someone
 * else's address into the sign-up form, from any number of networks; without a per-address ceiling that
 * is a way to flood a stranger's inbox, and without a daily ceiling it spends the day's sending quota so
 * the weekly digest itself cannot go out.
 */
export function allowConfirmationMail(email: string): boolean {
  const addr = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  if (!rateLimit(`confirm-mail:${addr}`, CONFIRMATION_MAILS_PER_ADDRESS, 86_400_000).ok) return false;
  return rateLimit("confirm-mail:all", CONFIRMATION_MAILS_PER_DAY, 86_400_000).ok;
}
