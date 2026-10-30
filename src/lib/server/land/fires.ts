import { and, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { firePoints } from "@/lib/db/schema";
import { distanceToPlotM, type Plot } from "./plot";

/**
 * Fires on a plot since 2020 from the NASA FIRMS VIIRS record (fire_points).
 * A VIIRS pixel is about 375 m across, so a detection counts when its centre
 * is inside the plot or within half a pixel of its edge.
 */
const HALF_PIXEL_M = 190;

export interface PlotFires {
  byYear: Record<string, number>;
  total: number;
  firstDate: string | null;
  lastDate: string | null;
  /** The period the fire record covers, so an empty result can be read correctly. */
  recordFrom: string | null;
  recordTo: string | null;
}

export async function plotFires(plot: Plot): Promise<PlotFires> {
  const db = await getDb();
  const pad = 0.003; // about 330 m
  const [minLon, minLat, maxLon, maxLat] = plot.bbox;
  const [rows, [range]] = await Promise.all([
    db
      .select({ lon: firePoints.lon, lat: firePoints.lat, date: firePoints.acqDate })
      .from(firePoints)
      .where(and(gte(firePoints.lon, minLon - pad), lte(firePoints.lon, maxLon + pad), gte(firePoints.lat, minLat - pad), lte(firePoints.lat, maxLat + pad)))
      .limit(5000),
    db.select({ from: sql<string | null>`min(${firePoints.acqDate})::text`, to: sql<string | null>`max(${firePoints.acqDate})::text` }).from(firePoints),
  ]);
  const byYear: Record<string, number> = {};
  let first: string | null = null;
  let last: string | null = null;
  let total = 0;
  for (const r of rows) {
    if (distanceToPlotM(r.lon, r.lat, plot) > HALF_PIXEL_M) continue;
    const date = String(r.date);
    byYear[date.slice(0, 4)] = (byYear[date.slice(0, 4)] ?? 0) + 1;
    total++;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  }
  return { byYear, total, firstDate: first, lastDate: last, recordFrom: range?.from ?? null, recordTo: range?.to ?? null };
}
