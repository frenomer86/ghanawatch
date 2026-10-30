import type { NextRequest } from "next/server";
import { landQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";
import { landSummary, makePlot } from "@/lib/server/land/check";

/**
 * GET /api/v1/land-check?lat=&lon=&r=
 * What public data says about a plot (a circle of r metres around the pin):
 * GhanaWatch detections on it and the nearest suspected galamsey site, tree
 * cover loss since 2001, deforestation alerts and fires since 2020, protected
 * areas, and the newest close-up's date. The slower Sentinel-2 comparison
 * with early 2020 is at /land-check/change.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "heavy");
  const q = parseQuery(req, landQuery);
  const summary = await landSummary(makePlot(q.lat, q.lon, q.r));
  return json(summary, { cache: summary.notes.length ? "short" : "medium" });
});
