import { eq, sql } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import { pointInPolygon } from "@/lib/geo";
import { adminBoundaries, reservoirs } from "../schema";
import { RESERVOIRS, summarise, type ReservoirDef, type ReservoirObservation, type ReservoirSummary } from "@/lib/domain/reservoirs";
import { getDb, rows as toRows } from "../client";

export interface ReservoirCard extends ReservoirDef {
  areaKm2: number | null;
  /** The last 13 months, one value per pass (both orbit directions), oldest first. */
  series: ReservoirObservation[];
  summary: ReservoirSummary;
}

/** Every watched water body with its recent radar series and its latest state, in the order of the list. */
export async function reservoirCards(): Promise<ReservoirCard[]> {
  const db = await getDb();
  const rs = toRows<{ slug: string; date: string; water_km2: number; water_pct: number; observed_pct: number; area_km2: number }>(
    await db.execute(sql`
      select o.slug, o.date::text as date, o.water_km2, o.water_pct, o.observed_pct, r.area_km2
      from reservoir_observations o join reservoirs r on r.slug = o.slug
      where o.date >= current_date - 400
      order by o.date`),
  );
  const areas = toRows<{ slug: string; area_km2: number }>(await db.execute(sql`select slug, area_km2 from reservoirs`));
  return RESERVOIRS.map((def) => {
    // Two passes on one day (both orbit directions) are averaged into one point.
    const byDay = new Map<string, ReservoirObservation[]>();
    for (const r of rs.filter((x) => x.slug === def.slug)) {
      const o = { date: r.date, waterKm2: Number(r.water_km2), waterPct: Number(r.water_pct), observedPct: Number(r.observed_pct) };
      byDay.set(r.date, [...(byDay.get(r.date) ?? []), o]);
    }
    const series = [...byDay.values()].map((os) => ({
      date: os[0].date,
      waterKm2: os.reduce((a, o) => a + o.waterKm2, 0) / os.length,
      waterPct: os.reduce((a, o) => a + o.waterPct, 0) / os.length,
      observedPct: Math.max(...os.map((o) => o.observedPct)),
    }));
    const area = areas.find((a) => a.slug === def.slug)?.area_km2;
    return { ...def, areaKm2: area == null ? null : Number(area), series, summary: summarise(series) };
  });
}

/**
 * The watched water bodies that reach into a district: their bounding boxes overlap and at least one of up to
 * 300 points along the outline lies inside the district's boundary (Lake Volta touches many districts).
 */
export async function reservoirsInDistrict(districtId: string): Promise<ReservoirCard[]> {
  const db = await getDb();
  const [d] = await db
    .select({ geom: adminBoundaries.geom, minLon: adminBoundaries.bboxMinLon, minLat: adminBoundaries.bboxMinLat, maxLon: adminBoundaries.bboxMaxLon, maxLat: adminBoundaries.bboxMaxLat })
    .from(adminBoundaries)
    .where(eq(adminBoundaries.id, districtId))
    .limit(1);
  const g = d?.geom as Polygon | MultiPolygon | null | undefined;
  if (!d || !g || (g.type !== "Polygon" && g.type !== "MultiPolygon") || d.minLon == null || d.minLat == null || d.maxLon == null || d.maxLat == null) return [];
  const outlines = await db.select({ slug: reservoirs.slug, geom: reservoirs.geom, bbox: reservoirs.bbox }).from(reservoirs);
  const touching = new Set<string>();
  for (const o of outlines) {
    const [w, s, e, n] = o.bbox;
    if (e < d.minLon || w > d.maxLon || n < d.minLat || s > d.maxLat) continue;
    const pts = o.geom.coordinates.flatMap((p) => p[0] ?? []);
    const step = Math.max(1, Math.floor(pts.length / 300));
    for (let i = 0; i < pts.length; i += step) {
      const [lon, lat] = pts[i];
      if (lon < d.minLon || lon > d.maxLon || lat < d.minLat || lat > d.maxLat) continue;
      if (pointInPolygon([lon, lat], g)) {
        touching.add(o.slug);
        break;
      }
    }
  }
  if (!touching.size) return [];
  return (await reservoirCards()).filter((c) => touching.has(c.slug));
}
