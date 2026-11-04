import { sql } from "drizzle-orm";
import { slugify } from "@/lib/domain/scorecards";
import { aqiLevel, heatLevel, AQI_LEVELS, HEAT_LEVELS, type AqiLevel, type HeatLevel } from "@/lib/domain/air-heat";
import { getDb, rows as toRows } from "../client";

export interface AirHeatDay {
  day: string;
  aqi: number | null;
  pm25: number | null;
  pm10: number | null;
  dust: number | null;
  tempMaxC: number | null;
  feelsLikeMaxC: number | null;
  wetBulbMaxC: number | null;
  aqiLevel: AqiLevel | null;
  heatLevel: HeatLevel | null;
}

export interface DistrictAirHeat {
  districtId: string;
  district: string;
  region: string | null;
  slug: string;
  /** Today and the days ahead. */
  days: AirHeatDay[];
  maxAqi: number | null;
  maxFeelsLikeC: number | null;
  computedAt: string;
}

const num = (v: unknown) => (v == null ? null : Number(v));

/** Today and the days ahead for every district (Ghana's day, which is UTC). */
export async function airHeatOutlook(): Promise<DistrictAirHeat[]> {
  const db = await getDb();
  const rs = toRows<{
    district_id: string;
    district: string;
    region: string | null;
    day: string;
    aqi: number | null;
    pm25: number | null;
    pm10: number | null;
    dust: number | null;
    temp_max_c: number | null;
    feels_like_max_c: number | null;
    wet_bulb_max_c: number | null;
    computed_at: string;
  }>(
    await db.execute(sql`
      select a.district_id, d.name as district, p.name as region, a.day::text as day, a.aqi, a.pm25, a.pm10, a.dust,
             a.temp_max_c, a.feels_like_max_c, a.wet_bulb_max_c, a.computed_at::text as computed_at
      from district_air_heat a
      join admin_boundaries d on d.id = a.district_id
      left join admin_boundaries p on p.id = d.parent_id
      where a.day >= (now() at time zone 'UTC')::date
      order by a.day`),
  );
  const by = new Map<string, DistrictAirHeat>();
  for (const r of rs) {
    let o = by.get(r.district_id);
    if (!o) {
      o = { districtId: r.district_id, district: r.district, region: r.region, slug: slugify(r.district), days: [], maxAqi: null, maxFeelsLikeC: null, computedAt: r.computed_at };
      by.set(r.district_id, o);
    }
    const day: AirHeatDay = {
      day: r.day,
      aqi: num(r.aqi),
      pm25: num(r.pm25),
      pm10: num(r.pm10),
      dust: num(r.dust),
      tempMaxC: num(r.temp_max_c),
      feelsLikeMaxC: num(r.feels_like_max_c),
      wetBulbMaxC: num(r.wet_bulb_max_c),
      aqiLevel: aqiLevel(num(r.aqi)),
      heatLevel: heatLevel(num(r.feels_like_max_c), num(r.wet_bulb_max_c)),
    };
    o.days.push(day);
    if (day.aqi != null) o.maxAqi = Math.max(o.maxAqi ?? 0, day.aqi);
    if (day.feelsLikeMaxC != null) o.maxFeelsLikeC = Math.max(o.maxFeelsLikeC ?? -99, day.feelsLikeMaxC);
    if (r.computed_at > o.computedAt) o.computedAt = r.computed_at;
  }
  return [...by.values()];
}

export async function districtAirHeat(districtId: string): Promise<DistrictAirHeat | null> {
  return (await airHeatOutlook()).find((o) => o.districtId === districtId) ?? null;
}

/** How many districts are at each level today. */
export function levelCounts(all: DistrictAirHeat[]): { air: Record<AqiLevel, number>; heat: Record<HeatLevel, number>; today: string | null } {
  const today = all.map((o) => o.days[0]?.day).filter(Boolean).sort()[0] ?? null;
  const air = Object.fromEntries(AQI_LEVELS.map((l) => [l, 0])) as Record<AqiLevel, number>;
  const heat = Object.fromEntries(HEAT_LEVELS.map((l) => [l, 0])) as Record<HeatLevel, number>;
  for (const o of all) {
    const d = o.days.find((x) => x.day === today);
    if (d?.aqiLevel) air[d.aqiLevel]++;
    if (d?.heatLevel) heat[d.heatLevel]++;
  }
  return { air, heat, today };
}
