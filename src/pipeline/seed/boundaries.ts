import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { adminBoundaries } from "@/lib/db/schema";
import { areaHectares, bboxOf, centroidOf, pointInPolygon } from "@/lib/geo";
import { stableId } from "@/lib/server/ids";

type Props = { name: string; code: string; iso?: string };
type FC = FeatureCollection<Polygon | MultiPolygon, Props>;

/**
 * Loads regions and districts from public/boundaries (geoBoundaries, simplified
 * with mapshaper) into admin_boundaries. Districts are attached to the region
 * that contains their centroid. Idempotent: rows are upserted by code.
 */
export async function seedBoundaries(db: Db, log: (s: string) => void) {
  const root = path.join(process.cwd(), "public", "boundaries");
  const regions = JSON.parse(fs.readFileSync(path.join(root, "ghana-regions.geojson"), "utf8")) as FC;
  const districts = JSON.parse(fs.readFileSync(path.join(root, "ghana-districts.geojson"), "utf8")) as FC;

  const regionRows = regions.features.map((f) => {
    const b = bboxOf(f.geometry);
    const c = centroidOf(f.geometry);
    return {
      id: stableId("boundary", f.properties.code),
      level: "region",
      code: f.properties.code,
      name: f.properties.name,
      parentId: null as string | null,
      geom: f.geometry,
      bboxMinLon: b[0],
      bboxMinLat: b[1],
      bboxMaxLon: b[2],
      bboxMaxLat: b[3],
      centroidLon: c.lon,
      centroidLat: c.lat,
      areaKm2: Math.round(areaHectares(f.geometry)) / 100,
    };
  });

  let orphans = 0;
  const districtRows = districts.features.map((f) => {
    const b = bboxOf(f.geometry);
    const c = centroidOf(f.geometry);
    const region = regions.features.find((r) => pointInPolygon([c.lon, c.lat], r.geometry));
    if (!region) orphans++;
    return {
      id: stableId("boundary", f.properties.code),
      level: "district",
      code: f.properties.code,
      name: f.properties.name,
      parentId: region ? stableId("boundary", region.properties.code) : null,
      geom: f.geometry,
      bboxMinLon: b[0],
      bboxMinLat: b[1],
      bboxMaxLon: b[2],
      bboxMaxLat: b[3],
      centroidLon: c.lon,
      centroidLat: c.lat,
      areaKm2: Math.round(areaHectares(f.geometry)) / 100,
    };
  });

  for (const batch of chunk([...regionRows, ...districtRows], 50)) {
    await db
      .insert(adminBoundaries)
      .values(batch)
      .onConflictDoUpdate({
        target: adminBoundaries.code,
        set: {
          name: sql`excluded.name`,
          parentId: sql`excluded.parent_id`,
          geom: sql`excluded.geom`,
          bboxMinLon: sql`excluded.bbox_min_lon`,
          bboxMinLat: sql`excluded.bbox_min_lat`,
          bboxMaxLon: sql`excluded.bbox_max_lon`,
          bboxMaxLat: sql`excluded.bbox_max_lat`,
          centroidLon: sql`excluded.centroid_lon`,
          centroidLat: sql`excluded.centroid_lat`,
          areaKm2: sql`excluded.area_km2`,
          updatedAt: sql`now()`,
        },
      });
  }
  log(`boundaries: ${regionRows.length} regions, ${districtRows.length} districts (${orphans} without a containing region)`);
  return { regions: regionRows, districts: districtRows };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
