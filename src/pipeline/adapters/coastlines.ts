import { and, gte, lte, sql } from "drizzle-orm";
import { coastPoints, contextFeatures } from "@/lib/db/schema";
import { districtContaining } from "@/lib/db/repo/boundaries";
import { haversineKm } from "@/lib/geo";
import type { Adapter } from "./types";

/**
 * Coastline change for Ghana from Digital Earth Africa Coastlines (Bishop-Taylor et al., annual tide-corrected
 * shorelines from Landsat since 2000, CC BY 4.0), read from its public map server: the "hotspots" layer, one
 * point per kilometre of shoreline with the rate of change of the shoreline around it, its significance and
 * the distance it has moved each year. Ghana's stretch is everything east of the Côte d'Ivoire border at
 * Newtown (3.11° W) inside Ghana's coastal box, including the shores of the coastal lagoons. Each point is
 * named after the nearest town or village (OpenStreetMap, within 15 km) and placed in its district. The source
 * adds a year at a time, so this runs once a month.
 */
const SLUG = "deafrica-coastlines";
const LAYER = "coastlines:coastlines_v0_4_4_hotspots_zoom_3";
const WFS = "https://geoserver.digitalearth.africa/geoserver/wfs";
const BOX = { minLon: -3.11, maxLon: 1.21, minLat: 4.6, maxLat: 6.3 };

interface Feature {
  geometry: { type: "Point"; coordinates: [number, number] } | null;
  properties: Record<string, number | string | null>;
}

/** Rate, significance, certainty and the shoreline's movement since 2000, from one hotspot (pure; for tests). */
export function readHotspot(f: Feature) {
  if (!f.geometry) return null;
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const rate = typeof p.rate_time === "number" ? p.rate_time : null;
  if (rate == null) return null;
  const years = Object.keys(p)
    .filter((k) => /^dist_\d{4}$/.test(k) && typeof p[k] === "number")
    .map((k) => Number(k.slice(5)))
    .sort((a, b) => a - b);
  const latest = years.at(-1) ?? null;
  const d2000 = typeof p.dist_2000 === "number" ? p.dist_2000 : null;
  const change = latest != null && d2000 != null ? Math.round(((p[`dist_${latest}`] as number) - d2000) * 10) / 10 : null;
  return {
    lon: Math.round(lon * 1e5) / 1e5,
    lat: Math.round(lat * 1e5) / 1e5,
    rateMYr: rate,
    sig: typeof p.sig_time === "number" ? p.sig_time : null,
    se: typeof p.se_time === "number" ? p.se_time : null,
    certainty: String(p.certainty ?? "unknown"),
    changeM: change,
    latestYear: latest,
  };
}

export const coastlinesAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 24 * 30,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    // In WFS 2.0 with EPSG:4326 the box is latitude first.
    const q = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: LAYER,
      outputFormat: "application/json",
      CQL_FILTER: `BBOX(the_geom,${BOX.minLat},${BOX.minLon},${BOX.maxLat},${BOX.maxLon})`,
    });
    const res = await ctx.fetchJson<{ features?: Feature[] }>(`${WFS}?${q}`);
    const points = (res.features ?? [])
      .map(readHotspot)
      .filter((p): p is NonNullable<ReturnType<typeof readHotspot>> => p !== null && p.lon >= BOX.minLon && p.lon <= BOX.maxLon && p.lat >= BOX.minLat && p.lat <= BOX.maxLat);
    if (points.length < 100) throw new Error(`${SLUG}: only ${points.length} coastline points returned`);

    const towns = (
      await db
        .select({ name: contextFeatures.name, lon: contextFeatures.centroidLon, lat: contextFeatures.centroidLat })
        .from(contextFeatures)
        .where(
          and(
            sql`${contextFeatures.kind} = 'settlement'`,
            sql`${contextFeatures.name} is not null`,
            gte(contextFeatures.centroidLon, BOX.minLon - 0.2),
            lte(contextFeatures.centroidLon, BOX.maxLon + 0.2),
            gte(contextFeatures.centroidLat, BOX.minLat - 0.2),
            lte(contextFeatures.centroidLat, BOX.maxLat + 0.2),
          ),
        )
    ).filter((t) => t.name);
    const rows: Array<typeof coastPoints.$inferInsert> = [];
    const districts = new Map<string, string | null>();
    for (const p of points) {
      let best: { name: string; d: number } | null = null;
      for (const t of towns) {
        const d = haversineKm(p, { lon: t.lon, lat: t.lat });
        if (d <= 15 && (!best || d < best.d)) best = { name: t.name!, d };
      }
      // Points 0.05° apart share a district lookup; the lookup is the slow part.
      const key = `${p.lon.toFixed(2)},${p.lat.toFixed(2)}`;
      if (!districts.has(key)) districts.set(key, (await districtContaining(p.lon, p.lat).catch(() => null))?.id ?? null);
      rows.push({ ...p, place: best?.name ?? null, districtId: districts.get(key) ?? null, computedAt: ctx.now });
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from coast_points`);
      for (let i = 0; i < rows.length; i += 500) await tx.insert(coastPoints).values(rows.slice(i, i + 500));
    });
    ctx.log(`${SLUG}: ${rows.length} coastline points, latest shoreline year ${Math.max(...rows.map((r) => r.latestYear ?? 0))}`);
    return { events: [], watermark: ctx.now, extra: { points: rows.length } };
  },
};
