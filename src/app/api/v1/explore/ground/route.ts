import type { NextRequest } from "next/server";
import { explorePointQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";
import { groundAround } from "@/lib/server/explore/ground";

/**
 * GET /api/v1/explore/ground?lat=&lon=
 *
 * What is on the ground around a point: mapped schools, cemeteries, clinics,
 * places of worship and settlements within 3 km, whether it lies in a protected
 * area, public photographs within 10 km, and street-level imagery within 1 km.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, explorePointQuery);
  const body = await groundAround(q.lon, q.lat);
  return json(body, { cache: body.notes.length ? "short" : "medium" });
});
