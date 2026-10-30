import type { NextRequest } from "next/server";
import { z } from "zod";
import { bboxParam } from "@/lib/domain/validation";
import { CHANGE_TYPES, SEVERITIES } from "@/lib/domain/types";
import { listFootprints } from "@/lib/db/repo/footprints";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";

const query = z
  .object({
    bbox: bboxParam,
    hours: z.coerce.number().int().min(1).max(24 * 365).default(72),
    type: z.enum(CHANGE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    possible: z.enum(["0", "1"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(300),
  })
  .strict();

/** GET /api/v1/footprints?bbox=… — detection polygons for the zoomed-in map (bbox required). */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, query);
  const fc = await listFootprints({ bbox: q.bbox, since: new Date(Date.now() - q.hours * 3_600_000), type: q.type, severity: q.severity, possible: q.possible, limit: q.limit });
  return json(fc, { cache: "short", headers: { "content-type": "application/geo+json; charset=utf-8" } });
});
