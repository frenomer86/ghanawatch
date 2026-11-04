import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "../client";

/** New tracks into forest (src/pipeline/context/roads.ts), for district and reserve pages. */
export interface NewRoad {
  id: string;
  title: string;
  lengthM: number;
  firstSeen: string;
  severity: string;
  reserve: string | null;
  inside: boolean;
}

export interface RoadSummary {
  count: number;
  km: number;
  insideReserves: number;
  roads: NewRoad[];
}

const DAYS = 90;

async function summary(where: ReturnType<typeof sql>): Promise<RoadSummary> {
  const db = await getDb();
  const rs = toRows<{ id: string; title: string; length_m: number | null; first_seen: string; severity: string; reserve: string | null; inside: boolean | null }>(
    await db.execute(sql`
      select id, title_en as title, (properties->>'lengthM')::float as length_m, image_date::text as first_seen, severity,
             properties#>>'{roadContext,reserve}' as reserve, (properties#>>'{roadContext,inside}')::boolean as inside
      from change_events
      where properties->>'signature' = 'new_road' and status <> 'dismissed' and confidence in ('medium', 'high')
        and image_date >= current_date - ${DAYS}::int and ${where}
      order by (properties#>>'{roadContext,inside}')::boolean desc nulls last, (properties->>'lengthM')::float desc
      limit 200`),
  );
  const roads = rs.map((r) => ({ id: r.id, title: r.title, lengthM: Number(r.length_m ?? 0), firstSeen: r.first_seen, severity: r.severity, reserve: r.reserve, inside: !!r.inside }));
  return {
    count: roads.length,
    km: Math.round(roads.reduce((a, r) => a + r.lengthM, 0) / 100) / 10,
    insideReserves: roads.filter((r) => r.inside).length,
    roads,
  };
}

/** New tracks into forest first seen in a district in the last 90 days. */
export function districtRoads(districtId: string): Promise<RoadSummary> {
  return summary(sql`district_id = ${districtId}`);
}

/** New tracks inside or within 1 km of a named reserve in the last 90 days. */
export function reserveRoads(name: string): Promise<RoadSummary> {
  return summary(sql`properties#>>'{roadContext,reserve}' = ${name}`);
}
