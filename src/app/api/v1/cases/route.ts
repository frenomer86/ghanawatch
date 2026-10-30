import type { NextRequest } from "next/server";
import { casesQuery } from "@/lib/domain/validation";
import { listPublicCases } from "@/lib/db/repo/cases";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";

/**
 * GET /api/v1/cases?limit=&category=
 * Citizen reports a moderator has approved, newest first, each with its
 * satellite verdict and where its case trail has reached. Coordinates are
 * rounded to about 100 m; reporters are never identified.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, casesQuery);
  const items = await listPublicCases({ limit: q.limit, category: q.category });
  return json({ items }, { cache: "short" });
});
