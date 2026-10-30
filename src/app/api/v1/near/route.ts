import type { NextRequest } from "next/server";
import { nearQuery } from "@/lib/domain/validation";
import { nearEvents } from "@/lib/db/repo/events";
import { districtContaining } from "@/lib/db/repo/boundaries";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";

/** GET /api/v1/near?lon=&lat=&radiusKm= — detections around a point plus the containing district. */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, nearQuery);
  const locale = req.nextUrl.searchParams.get("lang") === "tw" ? "tw" : "en";
  const [items, district] = await Promise.all([
    nearEvents({ lon: q.lon, lat: q.lat }, q.radiusKm, q.limit, locale),
    districtContaining(q.lon, q.lat),
  ]);
  // Location queries are personal; never cache them at the edge.
  return json({ items, district }, { cache: "none" });
});
