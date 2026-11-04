import { sql } from "drizzle-orm";
import { adminBoundaries, districtAirHeat } from "@/lib/db/schema";
import { dailyAir, dailyHeat } from "@/lib/domain/air-heat";
import type { Adapter } from "./types";

/**
 * Air quality and heat for every district of Ghana, read at each district's centre from two keyless
 * Open-Meteo APIs every three hours:
 *   - Air Quality: the CAMS global atmospheric-composition forecast (about 45 km), hourly PM2.5, PM10,
 *     Saharan dust and the US AQI, yesterday to three days ahead. During the Harmattan (roughly November to
 *     March) dust from the Sahara and Sahel drives the AQI far above anything traffic or burning does.
 *   - Forecast: the day's highest temperature and apparent (feels-like) temperature, and the hourly wet-bulb
 *     temperature, today and the next two days.
 * One row per district and day (src/lib/domain/air-heat.ts reduces the hours). Past days stay as a record for
 * two years; each run replaces the days still ahead. No events go to the change feed: air and heat are shown on
 * their own page and on each district's scorecard.
 */
const SLUG = "open-meteo-air";
const BATCH = 50;

interface AirResponse {
  hourly?: { time: string[]; pm2_5?: Array<number | null>; pm10?: Array<number | null>; dust?: Array<number | null>; us_aqi?: Array<number | null> };
}
interface HeatResponse {
  daily?: { time: string[]; temperature_2m_max?: Array<number | null>; apparent_temperature_max?: Array<number | null> };
  hourly?: { time: string[]; wet_bulb_temperature_2m?: Array<number | null> };
}

const coords = (b: Array<{ lon: number; lat: number }>) => `latitude=${b.map((d) => d.lat.toFixed(4)).join(",")}&longitude=${b.map((d) => d.lon.toFixed(4)).join(",")}`;

export const airHeatAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 3,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    const districts = (
      await db
        .select({ id: adminBoundaries.id, lon: adminBoundaries.centroidLon, lat: adminBoundaries.centroidLat })
        .from(adminBoundaries)
        .where(sql`${adminBoundaries.level} = 'district' and ${adminBoundaries.centroidLon} is not null`)
    ).filter((d) => d.lon != null && d.lat != null) as Array<{ id: string; lon: number; lat: number }>;

    type Row = typeof districtAirHeat.$inferInsert;
    const air: Row[] = [];
    const heat: Row[] = [];
    let airFailed = 0;
    let heatFailed = 0;
    for (let i = 0; i < districts.length; i += BATCH) {
      const batch = districts.slice(i, i + BATCH);
      try {
        const res = await ctx.fetchJson<AirResponse | AirResponse[]>(
          `https://air-quality-api.open-meteo.com/v1/air-quality?${coords(batch)}&hourly=pm2_5,pm10,dust,us_aqi&past_days=1&forecast_days=4&timezone=Africa%2FAccra`,
        );
        (Array.isArray(res) ? res : [res]).forEach((r, k) => {
          if (!batch[k] || !r?.hourly) return;
          for (const d of dailyAir(r.hourly)) air.push({ districtId: batch[k].id, day: d.day, pm25: d.pm25, pm10: d.pm10, dust: d.dust, aqi: d.aqi, computedAt: ctx.now });
        });
      } catch (e) {
        airFailed++;
        ctx.log(`${SLUG}: air batch ${i / BATCH + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
      try {
        const res = await ctx.fetchJson<HeatResponse | HeatResponse[]>(
          `https://api.open-meteo.com/v1/forecast?${coords(batch)}&daily=temperature_2m_max,apparent_temperature_max&hourly=wet_bulb_temperature_2m&forecast_days=3&timezone=Africa%2FAccra`,
        );
        (Array.isArray(res) ? res : [res]).forEach((r, k) => {
          if (!batch[k] || !r?.daily) return;
          for (const d of dailyHeat({ daily: r.daily, hourly: r.hourly })) {
            heat.push({ districtId: batch[k].id, day: d.day, tempMaxC: d.tempMaxC, feelsLikeMaxC: d.feelsLikeMaxC, wetBulbMaxC: d.wetBulbMaxC, computedAt: ctx.now });
          }
        });
      } catch (e) {
        heatFailed++;
        ctx.log(`${SLUG}: heat batch ${i / BATCH + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    const batches = Math.ceil(districts.length / BATCH);
    if (batches && airFailed === batches && heatFailed === batches) throw new Error(`${SLUG}: every request failed`);

    await db.transaction(async (tx) => {
      for (let i = 0; i < air.length; i += 500) {
        await tx
          .insert(districtAirHeat)
          .values(air.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [districtAirHeat.districtId, districtAirHeat.day],
            set: { pm25: sql`excluded.pm25`, pm10: sql`excluded.pm10`, dust: sql`excluded.dust`, aqi: sql`excluded.aqi`, computedAt: sql`excluded.computed_at` },
          });
      }
      for (let i = 0; i < heat.length; i += 500) {
        await tx
          .insert(districtAirHeat)
          .values(heat.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [districtAirHeat.districtId, districtAirHeat.day],
            set: { tempMaxC: sql`excluded.temp_max_c`, feelsLikeMaxC: sql`excluded.feels_like_max_c`, wetBulbMaxC: sql`excluded.wet_bulb_max_c`, computedAt: sql`excluded.computed_at` },
          });
      }
      await tx.execute(sql`delete from district_air_heat where day < current_date - 730`);
    });
    ctx.log(`${SLUG}: ${air.length} air and ${heat.length} heat district-days for ${districts.length} districts`);
    return { events: [], watermark: ctx.now, extra: { districts: districts.length, airDays: air.length, heatDays: heat.length, airFailed, heatFailed } };
  },
};
