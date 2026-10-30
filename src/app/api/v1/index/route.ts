import type { NextRequest } from "next/server";
import { indexQuery } from "@/lib/domain/validation";
import { INDEX_VERSION } from "@/lib/domain/index";
import { latestClosedMonth, rankings } from "@/lib/server/index/read";
import { enforceRateLimit, handle, HttpError, json, parseQuery } from "@/lib/server/http";

/**
 * GET /api/v1/index[?month=YYYY-MM&region=Ashanti%20Region&limit=10]
 * The district league table for a closed month (default the latest): rank, index, new and cumulative
 * hectares with their interval, and the movement against the month before.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, indexQuery);
  const latest = await latestClosedMonth();
  if (!latest) throw new HttpError(404, "No month has been closed yet");
  const month = q.month ?? latest.month;
  let rows = await rankings(month);
  if (!rows.length) throw new HttpError(404, `${month} is not a closed month`);
  if (q.region) rows = rows.filter((r) => r.region === q.region || r.region?.replace(/ Region$/, "") === q.region);
  if (q.limit) rows = rows.slice(0, q.limit);
  return json({ month, indexVersion: INDEX_VERSION, licence: "CC BY 4.0", definition: "index = hectares first seen as likely galamsey in the month, per 100 km² of the district", districts: rows }, { cache: "medium" });
});
