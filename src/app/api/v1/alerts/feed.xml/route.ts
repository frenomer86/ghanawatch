import type { NextRequest } from "next/server";
import { pastDigests } from "@/lib/server/alerts/digest";
import { env } from "@/lib/server/env";
import { escapeHtml } from "@/lib/server/mail";
import { enforceRateLimit, handle } from "@/lib/server/http";

/** GET /api/v1/alerts/feed.xml — the weekly digests as RSS, for newsrooms and feed readers. */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const origin = env().PUBLIC_ORIGIN;
  const items = (await pastDigests(26))
    .map(
      (d) => `<item><title>${escapeHtml(`GhanaWatch weekly, ${d.weekEnding}: ${d.newSites} new galamsey sites in ${d.districts} districts`)}</title><link>${origin}/alerts</link><guid isPermaLink="false">ghanawatch-weekly-${d.weekEnding}</guid><pubDate>${new Date(d.createdAt).toUTCString()}</pubDate><description>${escapeHtml(d.text.replace(/\*/g, ""))}</description></item>`,
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>GhanaWatch weekly alerts</title><link>${origin}/alerts</link><description>Likely galamsey sites first seen from space in the last seven days, by district, with evidence pages.</description><language>en</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=1800" } });
});
