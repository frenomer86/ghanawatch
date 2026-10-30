import type { NextRequest } from "next/server";
import { z } from "zod";
import { hotspotsQuery } from "@/lib/domain/validation";
import { NEW_WINDOW_HOURS } from "@/lib/domain/types";
import { gridHotspots } from "@/lib/db/repo/events";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";

const query = hotspotsQuery.extend({
  /** Grid cell size in degrees; the map picks this from its zoom level. */
  cell: z.coerce.number().min(0.005).max(1).default(0.1),
});

/**
 * GET /api/v1/hotspots
 * Events aggregated on a lon/lat grid for the national map, as GeoJSON points.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, query);
  const now = Date.now();
  const clusters = await gridHotspots({
    since: new Date(now - q.hours * 3_600_000),
    newSince: new Date(now - NEW_WINDOW_HOURS * 3_600_000),
    bbox: q.bbox,
    type: q.type,
    severity: q.severity,
    possible: q.possible,
    cellDeg: q.cell,
  });
  return json(
    {
      type: "FeatureCollection",
      features: clusters.map((c) => ({
        type: "Feature",
        id: c.key,
        geometry: { type: "Point", coordinates: [Number(c.lon.toFixed(5)), Number(c.lat.toFixed(5))] },
        properties: {
          key: c.key,
          type: c.type,
          severity: c.licensed ? "licensed" : c.severity,
          count: c.count,
          areaHa: c.areaHa,
          isNew: c.isNew,
          bbox: c.bbox,
          latestDetectedAt: c.latestDetectedAt,
          latestImageDate: c.latestImageDate,
          district: c.districtName,
          sampleId: c.sampleId,
        },
      })),
      window: { hours: q.hours, cellDeg: q.cell, generatedAt: new Date(now).toISOString() },
    },
    { cache: "short", headers: { "content-type": "application/geo+json; charset=utf-8" } },
  );
});
