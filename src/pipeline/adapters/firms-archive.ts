import { eq, sql } from "drizzle-orm";
import { firePoints } from "@/lib/db/schema";
import { GHANA_BBOX } from "@/lib/domain/types";
import { DistrictIndex, loadDistricts } from "../districts";
import { parseCsv } from "./firms";
import type { Adapter } from "./types";

/**
 * NASA FIRMS yearly country archive for Ghana (VIIRS, Suomi NPP), keyless:
 * https://firms.modaps.eosdis.nasa.gov/data/country/ . Every finished year
 * since 2020 is loaded once into fire_points, so "Check this land" can say
 * whether a plot has burned. Only detections FIRMS classifies as presumed
 * vegetation fires (type 0) with nominal or high confidence are kept.
 */
export const FIRST_ARCHIVE_YEAR = 2020;
const URL = (y: number) => `https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/${y}/viirs-snpp_${y}_Ghana.csv`;

export interface FireRow {
  lon: number;
  lat: number;
  acqDate: string;
  acqTime: string;
  confidence: string;
  frp: number | null;
  source: string;
}

export function parseCountryCsv(text: string, source: string): FireRow[] {
  const [minLon, minLat, maxLon, maxLat] = GHANA_BBOX;
  const out: FireRow[] = [];
  for (const r of parseCsv(text)) {
    const conf = String(r.confidence ?? "").toLowerCase();
    if (conf !== "n" && conf !== "h") continue;
    if (r.type != null && r.type !== "" && r.type !== "0") continue;
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.acq_date ?? "")) continue;
    const frp = Number(r.frp);
    out.push({
      lon: Number(lon.toFixed(5)),
      lat: Number(lat.toFixed(5)),
      acqDate: r.acq_date,
      acqTime: String(r.acq_time ?? "0000").padStart(4, "0"),
      confidence: conf,
      frp: Number.isFinite(frp) ? frp : null,
      source,
    });
  }
  return out;
}

export const firmsArchiveAdapter: Adapter = {
  slug: "nasa-firms-archive",
  minIntervalHours: 24 * 7,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error("nasa-firms-archive needs the database");
    const loaded = await db
      .select({ year: sql<number>`extract(year from ${firePoints.acqDate})::int`, n: sql<number>`count(*)::int` })
      .from(firePoints)
      .where(eq(firePoints.source, "firms-archive"))
      .groupBy(sql`1`);
    const have = new Set(loaded.filter((r) => Number(r.n) > 0).map((r) => Number(r.year)));
    const notes: string[] = [];
    const years: Record<string, number> = {};
    let districts: DistrictIndex | null = null;
    for (let y = FIRST_ARCHIVE_YEAR; y < ctx.now.getUTCFullYear(); y++) {
      if (have.has(y)) continue;
      let text: string;
      try {
        text = await ctx.fetchText(URL(y));
      } catch (e) {
        // The newest year appears some weeks after it ends; try again next week.
        notes.push(`${y}: not available yet (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      districts ??= new DistrictIndex(await loadDistricts(db));
      const index = districts;
      const rows = parseCountryCsv(text, "firms-archive").map((r) => ({ ...r, districtId: index.find(r.lon, r.lat)?.id ?? null }));
      for (let i = 0; i < rows.length; i += 2000) await db.insert(firePoints).values(rows.slice(i, i + 2000)).onConflictDoNothing();
      years[y] = rows.length;
      ctx.log(`nasa-firms-archive: ${y}: ${rows.length} detections stored`);
    }
    if (!Object.keys(years).length && !notes.length) notes.push("all years since 2020 already stored");
    return { events: [], notes, extra: { years } };
  },
};
