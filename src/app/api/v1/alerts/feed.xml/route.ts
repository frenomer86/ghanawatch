import type { NextRequest } from "next/server";
import { pastDigests } from "@/lib/server/alerts/digest";
import { env } from "@/lib/server/env";
import { escapeHtml, stripXmlInvalid } from "@/lib/server/mail";
import { enforceRateLimit, handle } from "@/lib/server/http";

/**
 * GET /api/v1/alerts/feed.xml — the weekly digests as RSS, for newsrooms and feed readers.
 * Digest text carries place names from OpenStreetMap, which anyone can edit, so every value is escaped
 * (and stripped of characters XML forbids) and the document is served with nosniff and a policy that
 * lets nothing in it run if a browser opens it.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const origin = escapeHtml(env().PUBLIC_ORIGIN);
  const x = (s: string) => escapeHtml(stripXmlInvalid(s));
  const items = (await pastDigests(26))
    .map(
      (d) =>
        `<item><title>${x(`GhanaWatch weekly, ${d.weekEnding}: ${d.newSites} new galamsey sites in ${d.districts} districts`)}</title><link>${origin}/alerts</link><guid isPermaLink="false">ghanawatch-weekly-${x(d.weekEnding)}</guid><pubDate>${new Date(d.createdAt).toUTCString()}</pubDate><description>${x(d.text.replace(/\*/g, ""))}</description></item>`,
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>GhanaWatch weekly alerts</title><link>${origin}/alerts</link><description>Likely galamsey sites first seen from space in the last seven days, by district, with evidence pages.</description><language>en</language>${items}</channel></rss>`;
  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=1800, s-maxage=1800, stale-while-revalidate=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
});
