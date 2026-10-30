import { sql } from "drizzle-orm";
import type { LineString, MultiLineString } from "geojson";
import { getDb, rows as toRows } from "@/lib/db/client";
import { monthOf } from "@/lib/domain/index";
import { slugify } from "@/lib/domain/scorecards";
import { distanceToLineM, reaches, riverLengthKm, riverLinesFromGeom, type Reach, type RiverLine } from "@/lib/geo/rivers";
import { TtlCache } from "@/lib/server/explore/cache";
import { listIntakes, type Intake } from "@/lib/server/index/intakes";

/**
 * River scorecards. Each watched river is cut into reaches of about 10 km; a reach is discoloured in a
 * month when Sentinel-2 saw the water turn brown there (a turbid-water detection within 1 km of the
 * reach, first seen that month), and heavily discoloured when those detections cover 5 ha or more.
 * Radar reflections consistent with dredgers are listed per reach too. Nothing here is a water-quality
 * measurement: it is what a free 10 m satellite can see from above.
 */
export const WATCH_LIST = ["Pra", "Ankobra", "Offin", "Birim", "Tano", "Densu", "Oda", "Bonsa"];
export const REACH_KM = 10;
const NEAR_M = 1000;
const HEAVY_HA = 5;

export type ReachClass = "clear" | "discoloured" | "heavy";

export interface ReachScore extends Reach {
  class: ReachClass;
  muddyHa: number;
  muddySites: number;
  dredgerTargets: number;
  intakes: Intake[];
}

export interface RiverScore {
  river: string;
  slug: string;
  lengthKm: number;
  mapped: boolean;
  reaches: ReachScore[];
  kmDiscoloured: number;
  kmHeavy: number;
  muddySites: number;
  dredgerTargets: number;
  intakes: Intake[];
  /** Months with a count of discoloured reaches, oldest first (the live record plus the history scan). */
  series: Array<{ month: string; kmDiscoloured: number; muddySites: number }>;
}

interface MuddyRow {
  id: string;
  month: string;
  lon: number;
  lat: number;
  ha: number;
}

const cache = new TtlCache<RiverScore[]>(4, 10 * 60_000);

export function riverScores(month?: string): Promise<RiverScore[]> {
  const m = month ?? monthOf(new Date());
  return cache.get(m, () => compute(m));
}

async function compute(month: string): Promise<RiverScore[]> {
  const db = await getDb();
  const lineRows = toRows<{ name: string | null; geom: LineString | MultiLineString }>(await db.execute(sql`select name, geom from river_lines where kind = 'river' and geom is not null order by name`));
  const linesByRiver = new Map<string, RiverLine[]>();
  for (const r of lineRows) {
    const name = normalise(r.name ?? "");
    if (!WATCH_LIST.includes(name)) continue;
    linesByRiver.set(name, [...(linesByRiver.get(name) ?? []), ...riverLinesFromGeom(name, r.geom)]);
  }
  const muddy = toRows<MuddyRow>(
    await db.execute(sql`
      select id::text, to_char(coalesce(first_image_date, image_date), 'YYYY-MM') as month, centroid_lon::float lon, centroid_lat::float lat, coalesce(area_ha, 0)::float ha
      from change_events
      where status <> 'dismissed' and method_version like 's2-galamsey-%' and (type = 'water_change' or properties->>'signature' = 'turbid_water')
      union all
      select id::text, scan_month as month, centroid_lon::float, centroid_lat::float, coalesce(area_ha, 0)::float
      from history_events
      where method_version like 's2-galamsey-%' and (type = 'water_change' or properties->>'signature' = 'turbid_water')`),
  );
  const targets = toRows<{ lon: number; lat: number; month: string }>(
    await db.execute(sql`select lon::float, lat::float, to_char(acq_date, 'YYYY-MM') as month from radar_targets where acq_date >= (current_date - interval '120 days')`),
  );
  const intakes = await listIntakes();
  const out: RiverScore[] = [];
  for (const river of WATCH_LIST) {
    const lines = linesByRiver.get(river) ?? [];
    const rs = reaches(lines, REACH_KM);
    const scored: ReachScore[] = rs.map((r) => {
      const near = muddy.filter((m) => m.month === month && Math.abs(m.lat - r.lat) < 0.12 && Math.abs(m.lon - r.lon) < 0.12 && distanceToLineM(m.lon, m.lat, r.coords) <= NEAR_M);
      const ha = near.reduce((a, x) => a + x.ha, 0);
      const dredgers = targets.filter((t) => Math.abs(t.lat - r.lat) < 0.12 && Math.abs(t.lon - r.lon) < 0.12 && distanceToLineM(t.lon, t.lat, r.coords) <= 200).length;
      return {
        ...r,
        class: ha >= HEAVY_HA ? "heavy" : near.length ? "discoloured" : "clear",
        muddyHa: Math.round(ha * 10) / 10,
        muddySites: near.length,
        dredgerTargets: dredgers,
        intakes: intakes.filter((i) => i.river === river && distanceToLineM(i.lon, i.lat, r.coords) <= 3000),
      };
    });
    // Monthly series: reaches discoloured per month across the whole record.
    const months = [...new Set(muddy.map((m) => m.month))].filter((m) => m <= month).sort();
    const series = months.map((mo) => {
      const inMonth = muddy.filter((m) => m.month === mo);
      let km = 0;
      let sites = 0;
      for (const r of rs) {
        const hits = inMonth.filter((m) => Math.abs(m.lat - r.lat) < 0.12 && Math.abs(m.lon - r.lon) < 0.12 && distanceToLineM(m.lon, m.lat, r.coords) <= NEAR_M);
        if (hits.length) {
          km += r.endKm - r.startKm;
          sites += hits.length;
        }
      }
      return { month: mo, kmDiscoloured: km, muddySites: sites };
    });
    out.push({
      river,
      slug: slugify(river),
      lengthKm: riverLengthKm(lines),
      mapped: lines.length > 0,
      reaches: scored,
      kmDiscoloured: scored.filter((r) => r.class !== "clear").reduce((a, r) => a + (r.endKm - r.startKm), 0),
      kmHeavy: scored.filter((r) => r.class === "heavy").reduce((a, r) => a + (r.endKm - r.startKm), 0),
      muddySites: scored.reduce((a, r) => a + r.muddySites, 0),
      dredgerTargets: scored.reduce((a, r) => a + r.dredgerTargets, 0),
      intakes: intakes.filter((i) => i.river === river),
      series,
    });
  }
  return out.sort((a, b) => b.kmDiscoloured - a.kmDiscoloured || a.river.localeCompare(b.river));
}

function normalise(name: string): string {
  const n = name.replace(/ River$/i, "").trim();
  return n === "Ofin" ? "Offin" : n;
}

export async function riverBySlug(slug: string, month?: string): Promise<RiverScore | null> {
  const all = await riverScores(month);
  return all.find((r) => r.slug === slug) ?? null;
}
