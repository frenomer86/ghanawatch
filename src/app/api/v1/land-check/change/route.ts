import type { NextRequest } from "next/server";
import { landQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, heavyWork, HttpError, json, parseQuery } from "@/lib/server/http";
import { landChange, makePlot } from "@/lib/server/land/check";

/**
 * GET /api/v1/land-check/change?lat=&lon=&r=
 * GhanaWatch's Sentinel-2 comparison of the plot: the 2020 dry season against
 * the last five months, with the national scan's rules. Reads satellite files
 * on demand, so the first answer for a plot takes a while; it is then cached.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "heavy");
  const q = parseQuery(req, landQuery);
  try {
    return json(await heavyWork(() => landChange(makePlot(q.lat, q.lon, q.r))), { cache: "medium" });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("[land-check/change]", e instanceof Error ? e.message : e);
    throw new HttpError(502, "The satellite comparison could not be completed. Try again later.");
  }
});
