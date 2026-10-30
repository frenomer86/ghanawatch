import type { NextRequest } from "next/server";
import { uuidParam } from "@/lib/domain/validation";
import { getEvent } from "@/lib/db/repo/events";
import { enforceRateLimit, handle, HttpError, json } from "@/lib/server/http";
import { eventToFeature } from "@/lib/server/export";

/** GET /api/v1/events/:id — full record with image references, provenance and citation. */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "public");
  const { id } = await ctx.params;
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) throw new HttpError(404, "Event not found");
  const locale = req.nextUrl.searchParams.get("lang") === "tw" ? "tw" : "en";
  const event = await getEvent(parsed.data, locale);
  if (!event) throw new HttpError(404, "Event not found");
  if (req.nextUrl.searchParams.get("format") === "geojson") {
    return json(eventToFeature(event, event.geometry), {
      cache: "medium",
      headers: { "content-type": "application/geo+json; charset=utf-8" },
    });
  }
  return json(event, { cache: "medium" });
});
