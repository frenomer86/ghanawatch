import { eq } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { adminBoundaries } from "@/lib/db/schema";
import { pointInPolygon } from "@/lib/geo";

/** District outlines for placing detections and fire points, with a coarse grid index for fast lookups. */
export interface DistrictShape {
  id: string;
  name: string;
  geom: Polygon | MultiPolygon;
  bbox: [number, number, number, number];
}

export async function loadDistricts(db: Db): Promise<DistrictShape[]> {
  const rows = await db.select().from(adminBoundaries).where(eq(adminBoundaries.level, "district"));
  return rows
    .filter((r) => r.geom && (r.geom.type === "Polygon" || r.geom.type === "MultiPolygon"))
    .map((r) => ({
      id: r.id,
      name: r.name,
      geom: r.geom as Polygon | MultiPolygon,
      bbox: [r.bboxMinLon ?? 0, r.bboxMinLat ?? 0, r.bboxMaxLon ?? 0, r.bboxMaxLat ?? 0],
    }));
}

export function districtFor(lon: number, lat: number, districts: DistrictShape[]): DistrictShape | null {
  for (const d of districts) {
    if (lon < d.bbox[0] || lon > d.bbox[2] || lat < d.bbox[1] || lat > d.bbox[3]) continue;
    if (pointInPolygon([lon, lat], d.geom)) return d;
  }
  return null;
}

const CELL = 0.1;

/** districtFor over many points: each 0.1° cell remembers the few districts whose box touches it. */
export class DistrictIndex {
  private cells = new Map<string, DistrictShape[]>();

  constructor(readonly districts: DistrictShape[]) {
    for (const d of districts) {
      for (let x = Math.floor(d.bbox[0] / CELL); x <= Math.floor(d.bbox[2] / CELL); x++) {
        for (let y = Math.floor(d.bbox[1] / CELL); y <= Math.floor(d.bbox[3] / CELL); y++) {
          const k = `${x}:${y}`;
          const list = this.cells.get(k);
          if (list) list.push(d);
          else this.cells.set(k, [d]);
        }
      }
    }
  }

  find(lon: number, lat: number): DistrictShape | null {
    return districtFor(lon, lat, this.cells.get(`${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`) ?? []);
  }
}
