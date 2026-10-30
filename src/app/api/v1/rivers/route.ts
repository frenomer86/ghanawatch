import type { NextRequest } from "next/server";
import { nationalQuery } from "@/lib/domain/validation";
import { riverScores } from "@/lib/server/rivers/score";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";

/**
 * GET /api/v1/rivers[?month=YYYY-MM]
 * River scorecards: for each watched river, the reaches where the water turned brown this month, the
 * drinking-water intakes on them, and the monthly series.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, nationalQuery);
  const rivers = await riverScores(q.month);
  return json(
    {
      licence: "CC BY 4.0",
      rivers: rivers.map((r) => ({ ...r, reaches: r.reaches.map(({ coords: _coords, ...reach }) => reach) })),
    },
    { cache: "medium" },
  );
});
