import type { NextRequest } from "next/server";
import { INDEX_VERSION } from "@/lib/domain/index";
import { slugParam } from "@/lib/domain/validation";
import { districtBySlug } from "@/lib/db/repo/scorecards";
import { districtSeries } from "@/lib/server/index/read";
import { enforceRateLimit, handle, HttpError, json } from "@/lib/server/http";

/**
 * GET /api/v1/scorecards/:slug
 * One district: its live scorecard (what the scan sees now) and its frozen monthly series from the index.
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "public");
  const { slug } = await ctx.params;
  if (!slugParam.safeParse(slug).success) throw new HttpError(404, "No such district");
  const d = await districtBySlug(slug);
  if (!d) throw new HttpError(404, "No such district");
  const series = await districtSeries(d.card.id);
  return json({ district: { id: d.card.id, name: d.card.name, slug: d.card.slug, region: d.card.region, areaKm2: d.card.areaKm2 }, live: d.card, indexVersion: INDEX_VERSION, series, licence: "CC BY 4.0" }, { cache: "medium" });
});
