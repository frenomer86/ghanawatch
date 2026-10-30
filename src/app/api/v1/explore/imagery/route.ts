import type { NextRequest } from "next/server";
import { explorePointQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, json, parseQuery } from "@/lib/server/http";
import type { ImageryResponse } from "@/lib/explore/imagery";
import { highResCaptures } from "@/lib/server/explore/wayback";
import { annualYears } from "@/lib/server/explore/mosaics";

/**
 * GET /api/v1/explore/imagery?lat=&lon=
 *
 * Imagery Ground view can show over a point from above: the distinct
 * high-resolution captures (Esri World Imagery Wayback, each with its capture
 * date) and the years with a cloud-free Sentinel-2 mosaic (EOX). Single
 * Sentinel-2 passes are listed separately by /explore/passes, which is slower.
 * A provider that fails leaves its list empty and adds a note.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, explorePointQuery);
  const notes: string[] = [];
  const soft = <T,>(label: string, fallback: T) => (e: unknown) => {
    notes.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  };
  const [highRes, years] = await Promise.all([
    highResCaptures(q.lon, q.lat).catch(soft("High-resolution imagery", [])),
    annualYears().catch(soft("Yearly mosaics", [] as number[])),
  ]);
  const body: ImageryResponse = { point: { lon: q.lon, lat: q.lat }, highRes, annualYears: years, notes };
  return json(body, { cache: notes.length ? "short" : "medium" });
});
