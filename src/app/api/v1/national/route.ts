import type { NextRequest } from "next/server";
import { nationalQuery } from "@/lib/domain/validation";
import { latestClosedMonth, nationalMonth, nationalSeries } from "@/lib/server/index/read";
import { enforceRateLimit, handle, HttpError, json, parseQuery } from "@/lib/server/http";
import { INDEX_VERSION } from "@/lib/domain/index";

/**
 * GET /api/v1/national[?month=YYYY-MM]
 * The frozen national Galamsey Index: the month asked for (default the latest closed month) and the
 * whole series. Figures never change under the same index version; corrections are listed at /data/methods.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, nationalQuery);
  const latest = await latestClosedMonth();
  if (!latest) throw new HttpError(404, "No month has been closed yet");
  const month = q.month ? await nationalMonth(q.month) : latest;
  if (!month) throw new HttpError(404, `${q.month} is not a closed month`);
  const series = await nationalSeries();
  return json({ indexVersion: INDEX_VERSION, licence: "CC BY 4.0", month, series, latest: latest.month }, { cache: "medium" });
});
