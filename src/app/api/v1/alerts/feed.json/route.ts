import type { NextRequest } from "next/server";
import { pastDigests } from "@/lib/server/alerts/digest";
import { env } from "@/lib/server/env";
import { enforceRateLimit, handle, json } from "@/lib/server/http";

/** GET /api/v1/alerts/feed.json — the weekly digests as a JSON Feed. */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const origin = env().PUBLIC_ORIGIN;
  const items = await pastDigests(26);
  return json(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: "GhanaWatch weekly alerts",
      home_page_url: `${origin}/alerts`,
      feed_url: `${origin}/api/v1/alerts/feed.json`,
      items: items.map((d) => ({ id: `ghanawatch-weekly-${d.weekEnding}`, url: `${origin}/alerts`, title: `${d.newSites} new galamsey sites in ${d.districts} districts, week ending ${d.weekEnding}`, content_text: d.text.replace(/\*/g, ""), date_published: d.createdAt, _ghanawatch: { newSites: d.newSites, newHa: d.newHa, districts: d.districts } })),
    },
    { cache: "medium" },
  );
});
