import type { NextRequest } from "next/server";
import { getFreshness } from "@/lib/db/repo/sources";
import { homeStats } from "@/lib/db/repo/events";
import { enforceRateLimit, handle, json } from "@/lib/server/http";

/** GET /api/v1/freshness: when the data last updated, the latest image date and headline counts (no per-source detail). */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const [freshness, stats] = await Promise.all([getFreshness(), homeStats()]);
  const { perSource: _perSource, ...pub } = freshness;
  void _perSource;
  return json({ ...pub, stats }, { cache: "short", headers: { "X-Data-Freshness": freshness.lastSuccessfulRunAt ?? "none" } });
});
