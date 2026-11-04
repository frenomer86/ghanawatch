import { sql } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import { rows as toRows, type Db } from "@/lib/db/client";
import { pointInPolygon } from "@/lib/geo";

/**
 * New tracks into forest placed against Ghana's forest reserves and other protected areas, and against the mining GhanaWatch has already found:
 *
 *   inside a reserve, with mining within 2 km   urgent    the track serves an active mining front
 *   inside a reserve                            elevated
 *   within 1 km of a reserve's edge             watch     approaching
 *   elsewhere in forest                         normal
 *
 * Tracks come from GhanaWatch's own 10 m Sentinel-2 scan of the reserves (src/pipeline/adapters/forest-tracks.ts)
 * and from Global Forest Watch's alert patches (src/pipeline/adapters/gfw-alerts.ts); each keeps the confidence
 * its source gave it. The title names the reserve. Runs after every pipeline run, over tracks first seen in the
 * last year; the result is kept in properties.roadContext.
 */
export const ROAD_RULES = { approachM: 1000, miningM: 2000, days: 365 } as const;

export interface Reserve {
  name: string | null;
  geom: Polygon | MultiPolygon;
  bbox: [number, number, number, number];
}

export interface RoadPlace {
  reserve: string | null;
  inside: boolean;
  /** Distance from the track to the reserve's edge when outside it, metres; null when no reserve is near. */
  distanceM: number | null;
  severity: "urgent" | "elevated" | "watch" | "normal";
}

const M_PER_DEG = 111_320;

/** Distance from a point to the nearest edge of a polygon, metres. */
export function edgeDistanceM(lon: number, lat: number, g: Polygon | MultiPolygon): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx;
      const ay = ring[i - 1][1] - lat;
      const bx = (ring[i][0] - lon) * kx;
      const by = ring[i][1] - lat;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const u = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
    }
  }
  return best * M_PER_DEG;
}

/** Where a track lies against the reserves, and the level that gives it (pure; exported for tests). */
export function placeRoad(line: Array<[number, number]>, reserves: Reserve[], miningWithinM: number | null): RoadPlace {
  const pad = ROAD_RULES.approachM / M_PER_DEG / 0.98;
  let inside: Reserve | null = null;
  let near: { r: Reserve; d: number } | null = null;
  for (const r of reserves) {
    const [w, s, e, n] = r.bbox;
    if (!line.some(([x, y]) => x >= w - pad && x <= e + pad && y >= s - pad && y <= n + pad)) continue;
    if (line.some(([x, y]) => pointInPolygon([x, y], r.geom))) {
      inside = r;
      break;
    }
    for (const [x, y] of line) {
      const d = edgeDistanceM(x, y, r.geom);
      if (d <= ROAD_RULES.approachM && (!near || d < near.d)) near = { r, d };
    }
  }
  const mining = miningWithinM != null && miningWithinM <= ROAD_RULES.miningM;
  if (inside) return { reserve: inside.name, inside: true, distanceM: 0, severity: mining ? "urgent" : "elevated" };
  if (near) return { reserve: near.r.name, inside: false, distanceM: Math.round(near.d), severity: "watch" };
  return { reserve: null, inside: false, distanceM: null, severity: "normal" };
}

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

export function roadTitle(lengthM: number, place: RoadPlace): string {
  const name = place.reserve ?? "a forest reserve";
  if (place.inside) return `New track cut into ${name}, about ${km(lengthM)}`;
  if (place.reserve) return `New track reaching ${name}, about ${km(lengthM)}, ${km(place.distanceM ?? 0)} from its edge`;
  return `New track cut through forest, about ${km(lengthM)}`;
}

export async function tagRoads(db: Db): Promise<{ inside: number; approaching: number; elsewhere: number }> {
  const roads = toRows<{ id: string; lon: number; lat: number; line: Array<[number, number]> | null; length_m: number }>(
    await db.execute(sql`
      select id, centroid_lon::float as lon, centroid_lat::float as lat, properties->'line' as line, (properties->>'lengthM')::float as length_m
      from change_events
      where properties->>'signature' = 'new_road' and status <> 'dismissed' and image_date >= current_date - ${ROAD_RULES.days}::int`),
  );
  if (!roads.length) return { inside: 0, approaching: 0, elsewhere: 0 };
  const reserves: Reserve[] = toRows<{ name: string | null; geom: Polygon | MultiPolygon; w: number; s: number; e: number; n: number }>(
    await db.execute(sql`
      select name, geom, bbox_min_lon::float as w, bbox_min_lat::float as s, bbox_max_lon::float as e, bbox_max_lat::float as n
      from context_features where kind = 'protected_area' and geom is not null and bbox_min_lon is not null`),
  )
    .filter((r) => r.geom.type === "Polygon" || r.geom.type === "MultiPolygon")
    .map((r) => ({ name: r.name, geom: r.geom, bbox: [r.w, r.s, r.e, r.n] }));
  const tally = { inside: 0, approaching: 0, elsewhere: 0 };
  for (const road of roads) {
    const line = road.line?.length ? road.line : [[road.lon, road.lat] as [number, number]];
    const d = 0.02;
    const [m] = toRows<{ dist: number | null }>(
      await db.execute(sql`
        select min(sqrt(power((centroid_lon - ${road.lon}) * ${Math.cos((road.lat * Math.PI) / 180)}, 2) + power(centroid_lat - ${road.lat}, 2))) * ${M_PER_DEG} as dist
        from change_events
        where status <> 'dismissed' and confidence in ('medium', 'high') and type = 'surface_disturbance'
          and centroid_lon between ${road.lon - d} and ${road.lon + d} and centroid_lat between ${road.lat - d} and ${road.lat + d}`),
    );
    const miningM = m?.dist == null ? null : Math.round(Number(m.dist));
    const place = placeRoad(line, reserves, miningM);
    if (place.inside) tally.inside++;
    else if (place.reserve) tally.approaching++;
    else tally.elsewhere++;
    const context = { reserve: place.reserve, inside: place.inside, distanceM: place.distanceM, miningWithinM: miningM };
    await db.execute(sql`
      update change_events set
        severity = ${place.severity},
        title_en = ${roadTitle(Number(road.length_m), place)},
        properties = (properties - 'contextDowngrade') || jsonb_build_object('roadContext', ${JSON.stringify(context)}::jsonb),
        updated_at = now()
      where id = ${road.id} and (severity <> ${place.severity} or coalesce(properties->'roadContext', 'null'::jsonb) <> ${JSON.stringify(context)}::jsonb)`);
  }
  return tally;
}
