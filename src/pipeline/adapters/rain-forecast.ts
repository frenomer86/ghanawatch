import { sql } from "drizzle-orm";
import type { Point } from "geojson";
import { adminBoundaries, districtRain } from "@/lib/db/schema";
import type { Adapter, NormalisedEvent } from "./types";

/**
 * Three-day rain forecast for every district of Ghana, from Open-Meteo's free forecast API (no key),
 * read at each district's centre. The forecast is kept per district and day for the Floods page and the
 * scorecards; a day with heavy rain becomes a flood-risk warning on the map.
 *
 * Levels follow common heavy-rain practice for West Africa: 50 mm in a day is heavy (watch), 80 mm very
 * heavy (elevated), 120 mm extreme (urgent). It is a model forecast for the district centre, not a
 * measurement, and storms are local: the warning means "be ready", not "it will flood here".
 */
const SLUG = "open-meteo";
const METHOD = "rain-forecast-1.0";
const DAYS = 3;
const BATCH = 50;
const HEAVY = 50;
const VERY_HEAVY = 80;
const EXTREME = 120;

interface Forecast {
  daily: { time: string[]; precipitation_sum: (number | null)[]; precipitation_hours: (number | null)[] };
  hourly?: { time: string[]; precipitation: (number | null)[] };
}

export const rainForecastAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 3,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    const districts = (
      await db
        .select({ id: adminBoundaries.id, name: adminBoundaries.name, lon: adminBoundaries.centroidLon, lat: adminBoundaries.centroidLat })
        .from(adminBoundaries)
        .where(sql`${adminBoundaries.level} = 'district' and ${adminBoundaries.centroidLon} is not null`)
    ).filter((d) => d.lon != null && d.lat != null) as Array<{ id: string; name: string; lon: number; lat: number }>;

    const events: NormalisedEvent[] = [];
    const rows: Array<typeof districtRain.$inferInsert> = [];
    for (let i = 0; i < districts.length; i += BATCH) {
      const batch = districts.slice(i, i + BATCH);
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${batch.map((d) => d.lat.toFixed(4)).join(",")}` +
        `&longitude=${batch.map((d) => d.lon.toFixed(4)).join(",")}` +
        `&daily=precipitation_sum,precipitation_hours&hourly=precipitation&forecast_days=${DAYS}&timezone=Africa%2FAccra`;
      const res = await ctx.fetchJson<Forecast | Forecast[]>(url);
      const list = Array.isArray(res) ? res : [res];
      list.forEach((f, k) => {
        const d = batch[k];
        if (!d || !f?.daily) return;
        f.daily.time.forEach((day, j) => {
          const mm = f.daily.precipitation_sum[j] ?? 0;
          const hourly = (f.hourly?.time ?? []).map((t, h) => (t.startsWith(day) ? (f.hourly?.precipitation[h] ?? 0) : 0));
          const maxHourly = hourly.length ? Math.max(...hourly) : null;
          rows.push({ districtId: d.id, day, rainMm: mm, rainHours: f.daily.precipitation_hours[j], maxHourlyMm: maxHourly, computedAt: ctx.now });
          if (mm >= HEAVY) events.push(toEvent(d, day, mm, maxHourly, ctx.now));
        });
      });
    }
    // Replace the whole forecast at once, so days that dropped out of the window disappear.
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from district_rain where day < current_date`);
      for (let i = 0; i < rows.length; i += 500) {
        await tx
          .insert(districtRain)
          .values(rows.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [districtRain.districtId, districtRain.day],
            set: { rainMm: sql`excluded.rain_mm`, rainHours: sql`excluded.rain_hours`, maxHourlyMm: sql`excluded.max_hourly_mm`, computedAt: sql`excluded.computed_at` },
          });
      }
    });
    ctx.log(`${SLUG}: ${rows.length} district-days for ${districts.length} districts, ${events.length} heavy-rain warnings`);
    return { events, watermark: ctx.now, extra: { districts: districts.length, warnings: events.length } };
  },
};

function toEvent(d: { id: string; name: string; lon: number; lat: number }, day: string, mm: number, maxHourly: number | null, now: Date): NormalisedEvent {
  const level = mm >= EXTREME ? "extreme" : mm >= VERY_HEAVY ? "very heavy" : "heavy";
  const rounded = Math.round(mm);
  const geom: Point = { type: "Point", coordinates: [d.lon, d.lat] };
  return {
    sourceSlug: SLUG,
    sourceEventId: `rain-${d.id}-${day}`,
    type: "flood_risk",
    detectedAt: now,
    imageDate: day,
    confidence: "medium",
    severity: mm >= EXTREME ? "urgent" : mm >= VERY_HEAVY ? "elevated" : "watch",
    geom,
    titleEn: `${level[0].toUpperCase()}${level.slice(1)} rain forecast, about ${rounded} mm on ${day}, ${d.name}`,
    descriptionEn: `About ${rounded} mm of rain is forecast in ${d.name} on ${day}${maxHourly != null && maxHourly >= 20 ? `, up to ${Math.round(maxHourly)} mm in one hour` : ""}. Drains, low-lying streets and river banks can flood. This is a forecast for the district, not a report of flooding; storms are local and can fall short or exceed it.`,
    methodVersion: METHOD,
    properties: { forecastMm: mm, maxHourlyMm: maxHourly, district: d.name },
  };
}
