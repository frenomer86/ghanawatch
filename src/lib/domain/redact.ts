/**
 * Personal contact details taken out of a report's description before it is stored, since a published report
 * is public and reporters are never identified: e-mail addresses, web links and phone numbers (Ghanaian numbers
 * written in any of the usual ways, and any other run of nine or more digits). Coordinates, dates, sizes and
 * money amounts are left alone.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|gh|io|me|info|co|ly|link)(?:\/\S*)?\b/gi;
// +233 24 123 4567, +44 7700 900123, 0241234567, 024-123-4567, (024) 123 4567, 233 24 123 4567, 241234567
const PHONE = /\+\s?\d[\d\s-]{7,}\d|\(?\b0\d{2}\)?[\s-]?\d{3}[\s-]?\d{4}\b|\b233[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\b\d{9,}\b/g;

export function redactContacts(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .replace(EMAIL, () => {
      removed++;
      return "[email removed]";
    })
    .replace(LINK, () => {
      removed++;
      return "[link removed]";
    })
    .replace(PHONE, () => {
      removed++;
      return "[number removed]";
    });
  return { text: out, removed };
}
