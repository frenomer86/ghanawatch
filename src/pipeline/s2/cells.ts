import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { adminBoundaries, analysisCells } from "@/lib/db/schema";
import { bboxIntersects, pointInPolygon } from "@/lib/geo";
import { chunk } from "../seed/boundaries";

/**
 * National scan grid: 0.2° cells (about 22 km) covering every part of Ghana.
 * Priority 2 (scanned more often, at 20 m): cells in regions where the
 * Forestry Commission and Minerals Commission report most galamsey (Western,
 * Western North, Central, Ashanti, Eastern, Ahafo, Bono, Upper East).
 * Priority 1 (40 m): the rest of the country.
 */
export const CELL_DEG = 0.2;
const ORIGIN = { lon: -3.4, lat: 4.6 };
const PRIORITY_REGIONS = /^(Western|Western North|Central|Ashanti|Eastern|Ahafo|Bono|Upper East) Region$/;

export async function seedCells(db: Db, log: (s: string) => void) {
  const outline = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "boundaries", "ghana-outline.geojson"), "utf8")) as FeatureCollection<
    Polygon | MultiPolygon
  >;
  const ghana = outline.features[0].geometry;
  const regions = (await db.select().from(adminBoundaries).where(eq(adminBoundaries.level, "region"))).filter((r) => r.geom);
  const rows: Array<typeof analysisCells.$inferInsert> = [];
  for (let ix = 0; ORIGIN.lon + ix * CELL_DEG < 1.3; ix++) {
    for (let iy = 0; ORIGIN.lat + iy * CELL_DEG < 11.3; iy++) {
      const minLon = +(ORIGIN.lon + ix * CELL_DEG).toFixed(4);
      const minLat = +(ORIGIN.lat + iy * CELL_DEG).toFixed(4);
      const maxLon = +(minLon + CELL_DEG).toFixed(4);
      const maxLat = +(minLat + CELL_DEG).toFixed(4);
      // Keep the cell if any of a 5×5 sample of points falls inside Ghana.
      let inside = false;
      let regionName: string | null = null;
      for (let a = 0; a < 5 && !inside; a++) {
        for (let b = 0; b < 5 && !inside; b++) {
          const p: [number, number] = [minLon + ((a + 0.5) * CELL_DEG) / 5, minLat + ((b + 0.5) * CELL_DEG) / 5];
          if (pointInPolygon(p, ghana)) inside = true;
        }
      }
      if (!inside) continue;
      const centre: [number, number] = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
      for (const r of regions) {
        const g = r.geom as Polygon | MultiPolygon;
        if (!bboxIntersects([r.bboxMinLon!, r.bboxMinLat!, r.bboxMaxLon!, r.bboxMaxLat!], [minLon, minLat, maxLon, maxLat])) continue;
        if (pointInPolygon(centre, g)) {
          regionName = r.name;
          break;
        }
      }
      const priority = regionName && PRIORITY_REGIONS.test(regionName) ? 2 : 1;
      rows.push({ id: `c${ix}_${iy}`, minLon, minLat, maxLon, maxLat, priority, resM: priority === 2 ? 20 : 40, regionName });
    }
  }
  for (const batch of chunk(rows, 200)) {
    await db
      .insert(analysisCells)
      .values(batch)
      .onConflictDoUpdate({
        target: analysisCells.id,
        set: { priority: sql`excluded.priority`, resM: sql`excluded.res_m`, regionName: sql`excluded.region_name` },
      });
  }
  const p2 = rows.filter((r) => r.priority === 2).length;
  log(`scan grid: ${rows.length} cells covering Ghana (${p2} priority at 20 m, ${rows.length - p2} at 40 m)`);
}

/** Cells due for a scan: never-scanned first, then oldest scan weighted by priority. */
export async function dueCells(db: Db, now: Date, limit: number) {
  const cells = await db.select().from(analysisCells);
  const score = (c: typeof analysisCells.$inferSelect) => {
    // A re-check asked for after the last scan (an outside signal named a place here) goes first.
    if (c.recheckRequestedAt && (!c.lastRunAt || c.recheckRequestedAt > c.lastRunAt)) return Number.POSITIVE_INFINITY;
    if (!c.lastRunAt) return Number.POSITIVE_INFINITY - (2 - c.priority);
    return ((now.getTime() - c.lastRunAt.getTime()) / 3_600_000) * c.priority;
  };
  return cells
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => (b.s === a.s ? b.c.priority - a.c.priority : b.s - a.s))
    .slice(0, limit)
    .map((x) => x.c);
}
