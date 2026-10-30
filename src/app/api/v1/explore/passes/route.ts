import type { NextRequest } from "next/server";
import { explorePointQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";
import type { PassesResponse } from "@/lib/explore/imagery";
import { recentPasses } from "@/lib/server/explore/passes";

/**
 * GET /api/v1/explore/passes?lat=&lon=
 *
 * The clearest Sentinel-2 pass of each month over the last ~13 months at a
 * point (Earth Search STAC, keyless), each with the URL of its 4 km frame and
 * the frame's corners. Cloud over the spot itself is measured when a frame is
 * drawn, not here.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, explorePointQuery);
  const notes: string[] = [];
  const passes = await recentPasses(q.lon, q.lat).catch((e: unknown) => {
    notes.push(`Sentinel-2 passes: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  });
  const body: PassesResponse = { point: { lon: q.lon, lat: q.lat }, passes, notes };
  return json(body, { cache: notes.length ? "short" : "medium" });
});
