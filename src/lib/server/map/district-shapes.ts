import { sql } from "drizzle-orm";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { getDb, rows as toRows } from "@/lib/db/client";
import { slugify } from "@/lib/domain/scorecards";
import { simplifyRing } from "@/pipeline/reservoirs/geometry";

/**
 * Ghana's district outlines as SVG paths, for the maps drawn on the server (the home page and district pages):
 * simplified to about 600 m, projected equirectangularly with the longitude scaled by the cosine of Ghana's
 * middle latitude, so the country keeps its shape. Built once an hour from the boundaries in the database.
 */
export interface DistrictShape {
  id: string;
  name: string;
  slug: string;
  region: string | null;
  d: string;
  /** Label point: the centre of the district's bounding box, in SVG units. */
  cx: number;
  cy: number;
}

export interface DistrictShapes {
  width: number;
  height: number;
  districts: DistrictShape[];
}

const BOX = { minLon: -3.3, maxLon: 1.25, minLat: 4.7, maxLat: 11.2 };
const SCALE = 100; // SVG units per degree of latitude
const KX = Math.cos((((BOX.minLat + BOX.maxLat) / 2) * Math.PI) / 180);
const TOL = 0.006;

export const project = (lon: number, lat: number): [number, number] => [(lon - BOX.minLon) * KX * SCALE, (BOX.maxLat - lat) * SCALE];

let cache: { at: number; value: Promise<DistrictShapes> } | null = null;

export function districtShapes(): Promise<DistrictShapes> {
  if (cache && Date.now() - cache.at < 3_600_000) return cache.value;
  const value = build().catch((e) => {
    cache = null;
    throw e;
  });
  cache = { at: Date.now(), value };
  return value;
}

function ringPath(ring: Position[]): string {
  const pts = simplifyRing(ring, TOL);
  if (pts.length < 4) return "";
  return (
    pts
      .map(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join("") + "Z"
  );
}

async function build(): Promise<DistrictShapes> {
  const db = await getDb();
  const rs = toRows<{ id: string; name: string; region: string | null; geom: Polygon | MultiPolygon | null; minlon: number; minlat: number; maxlon: number; maxlat: number }>(
    await db.execute(sql`
      select d.id, d.name, p.name as region, d.geom, d.bbox_min_lon::float as minlon, d.bbox_min_lat::float as minlat,
             d.bbox_max_lon::float as maxlon, d.bbox_max_lat::float as maxlat
      from admin_boundaries d left join admin_boundaries p on p.id = d.parent_id
      where d.level = 'district' and d.geom is not null`),
  );
  const districts: DistrictShape[] = [];
  for (const r of rs) {
    const g = r.geom;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    const d = polys.flatMap((p) => p.map(ringPath)).join("");
    if (!d) continue;
    const [cx, cy] = project((Number(r.minlon) + Number(r.maxlon)) / 2, (Number(r.minlat) + Number(r.maxlat)) / 2);
    districts.push({ id: r.id, name: r.name, slug: slugify(r.name), region: r.region, d, cx, cy });
  }
  const [width] = project(BOX.maxLon, BOX.minLat);
  return { width: Math.ceil(width), height: Math.ceil((BOX.maxLat - BOX.minLat) * SCALE), districts };
}
