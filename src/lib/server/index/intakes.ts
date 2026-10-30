import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "@/lib/db/client";
import { waterIntakes } from "@/lib/db/schema";
import { haversineKm } from "@/lib/geo";
import { stableId } from "@/lib/server/ids";
import { TtlCache } from "@/lib/server/explore/cache";

/**
 * Ghana Water Ltd raw-water intakes on the rivers galamsey silts. The seed list carries the three best
 * documented plants; the rest are entered by an administrator from GWCL and Water Resources Commission
 * records (name, river, coordinates). Coordinates are approximate plant locations, not pump points.
 */
export const SEED_INTAKES: Array<{ name: string; river: string; lon: number; lat: number; source: string }> = [
  { name: "Daboase water treatment plant", river: "Pra", lon: -1.6633, lat: 5.1733, source: "GWCL, Sekondi-Takoradi supply (approximate)" },
  { name: "Sekyere Hemang water treatment plant", river: "Pra", lon: -1.3217, lat: 5.1947, source: "GWCL, Cape Coast supply (approximate)" },
  { name: "Kyebi water treatment plant", river: "Birim", lon: -0.5533, lat: 6.1667, source: "GWCL, Kyebi and Abuakwa South (approximate)" },
];

export async function seedIntakes(log: (s: string) => void): Promise<void> {
  const db = await getDb();
  for (const i of SEED_INTAKES) {
    await db
      .insert(waterIntakes)
      .values({ id: stableId("intake", i.name), name: i.name, river: i.river, lon: i.lon, lat: i.lat, source: i.source })
      .onConflictDoNothing();
  }
  await db.execute(sql`
    update water_intakes w set district_id = d.id
    from admin_boundaries d
    where w.district_id is null and d.level = 'district'
      and w.lon between d.bbox_min_lon and d.bbox_max_lon and w.lat between d.bbox_min_lat and d.bbox_max_lat`);
  const [{ n }] = toRows<{ n: number }>(await db.execute(sql`select count(*)::int n from water_intakes`));
  log(`water intakes: ${n} on record`);
}

export interface Intake {
  id: string;
  name: string;
  river: string;
  operator: string;
  lon: number;
  lat: number;
  districtId: string | null;
  districtName: string | null;
}

const cache = new TtlCache<Intake[]>(1, 10 * 60_000);

export function listIntakes(): Promise<Intake[]> {
  return cache.get("all", async () => {
    const db = await getDb();
    return toRows<{ id: string; name: string; river: string; operator: string; lon: number; lat: number; district_id: string | null; district: string | null }>(
      await db.execute(sql`
        select w.id::text, w.name, w.river, w.operator, w.lon::float, w.lat::float, w.district_id::text, d.name as district
        from water_intakes w left join admin_boundaries d on d.id = w.district_id order by w.river, w.name`),
    ).map((r) => ({ id: r.id, name: r.name, river: r.river, operator: r.operator, lon: Number(r.lon), lat: Number(r.lat), districtId: r.district_id, districtName: r.district }));
  });
}

/** The intake nearest to a point, with the distance, for "how close is this to drinking water". */
export function nearestIntake(intakes: Intake[], lon: number, lat: number): { intake: Intake; km: number } | null {
  let best: { intake: Intake; km: number } | null = null;
  for (const i of intakes) {
    const km = haversineKm({ lon, lat }, { lon: i.lon, lat: i.lat });
    if (!best || km < best.km) best = { intake: i, km: Math.round(km * 10) / 10 };
  }
  return best;
}
