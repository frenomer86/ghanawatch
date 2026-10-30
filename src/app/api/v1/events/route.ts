import type { NextRequest } from "next/server";
import { eventsQuery } from "@/lib/domain/validation";
import { iterateEvents, listEvents } from "@/lib/db/repo/events";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";
import { csvStream, eventToCsvRow, eventToFeature, featureCollectionWithMeta } from "@/lib/server/export";

/**
 * GET /api/v1/events
 * Filterable list of change events, newest first, keyset-paginated.
 * ?format=csv|geojson streams up to 50 000 rows for research use.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, eventsQuery);
  const locale = req.nextUrl.searchParams.get("lang") === "tw" ? "tw" : "en";

  if (q.format === "csv") {
    const stamp = new Date().toISOString().slice(0, 10);
    const lines = (async function* () {
      for await (const e of iterateEvents(q, locale)) yield eventToCsvRow(e);
    })();
    return csvStream(lines, `ghanawatch-events-${stamp}.csv`);
  }

  if (q.format === "geojson") {
    const features = [];
    for await (const e of iterateEvents(q, locale, 20_000)) features.push(eventToFeature(e));
    return json(featureCollectionWithMeta(features), {
      cache: "short",
      headers: { "content-type": "application/geo+json; charset=utf-8" },
    });
  }

  const page = await listEvents(q, locale);
  return json({ items: page.items, nextCursor: page.nextCursor }, { cache: "short" });
});
