import type { NextRequest } from "next/server";
import { z } from "zod";
import { listDistricts, listRegions, searchBoundaries } from "@/lib/db/repo/boundaries";
import { searchQuery, uuidParam } from "@/lib/domain/validation";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";

const query = z
  .object({
    level: z.enum(["region", "district"]).default("district"),
    region: uuidParam.optional(),
    q: searchQuery.shape.q.optional(),
    limit: z.coerce.number().int().min(1).max(20).default(8),
  })
  .strict();

/** GET /api/v1/boundaries?level=region|district&region=<id>&q=<search> */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, query);
  if (q.q) return json({ items: await searchBoundaries(q.q, q.limit) }, { cache: "long" });
  const items = q.level === "region" ? await listRegions() : await listDistricts(q.region);
  return json({ items }, { cache: "long" });
});
