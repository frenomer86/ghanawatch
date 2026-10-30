import { sql } from "drizzle-orm";
import { slugify } from "@/lib/domain/scorecards";
import { getDb, rows as toRows } from "../client";

export interface DistrictRainOutlook {
  districtId: string;
  district: string;
  region: string | null;
  slug: string;
  days: Array<{ day: string; mm: number }>;
  maxMm: number;
  computedAt: string;
}

/** Heavy-rain levels used across the Floods section (mm in one day). */
export const RAIN_LEVELS = { heavy: 50, veryHeavy: 80, extreme: 120 } as const;

export function rainLevel(mm: number): "extreme" | "veryHeavy" | "heavy" | "light" {
  return mm >= RAIN_LEVELS.extreme ? "extreme" : mm >= RAIN_LEVELS.veryHeavy ? "veryHeavy" : mm >= RAIN_LEVELS.heavy ? "heavy" : "light";
}

/** The three-day rain outlook for every district, wettest first. */
export async function rainOutlook(): Promise<DistrictRainOutlook[]> {
  const db = await getDb();
  const rs = toRows<{ district_id: string; district: string; region: string | null; day: string; rain_mm: number; computed_at: string }>(
    await db.execute(sql`
      select r.district_id, d.name as district, p.name as region, r.day::text as day, r.rain_mm, r.computed_at::text as computed_at
      from district_rain r
      join admin_boundaries d on d.id = r.district_id
      left join admin_boundaries p on p.id = d.parent_id
      where r.day >= current_date
      order by r.day`),
  );
  const by = new Map<string, DistrictRainOutlook>();
  for (const r of rs) {
    let o = by.get(r.district_id);
    if (!o) {
      o = { districtId: r.district_id, district: r.district, region: r.region, slug: slugify(r.district), days: [], maxMm: 0, computedAt: r.computed_at };
      by.set(r.district_id, o);
    }
    o.days.push({ day: r.day, mm: Number(r.rain_mm) });
    o.maxMm = Math.max(o.maxMm, Number(r.rain_mm));
  }
  return [...by.values()].sort((a, b) => b.maxMm - a.maxMm);
}

/** One district's outlook, for its scorecard. */
export async function districtRainOutlook(districtId: string): Promise<DistrictRainOutlook | null> {
  return (await rainOutlook()).find((o) => o.districtId === districtId) ?? null;
}

export interface WaterwayEncroachment {
  id: string;
  title: string;
  district: string | null;
  areaHa: number;
  waterwayKind: "drain" | "canal" | "river" | "wetland";
  waterwayName: string | null;
  shown: boolean;
  beforeDate: string | null;
  afterDate: string | null;
}

/**
 * Clearing, pits or landfill seen inside drains, canals, rivers and wetlands (tagged by the pipeline), wetlands
 * and drains first. All of them are "possible" until checked.
 */
export async function waterwayEncroachments(limit = 24): Promise<{ items: WaterwayEncroachment[]; counts: Record<string, number> }> {
  const db = await getDb();
  const items = toRows<{
    id: string;
    title: string;
    district: string | null;
    area_ha: number | null;
    kind: WaterwayEncroachment["waterwayKind"];
    wname: string | null;
    confidence: string;
    before_date: string | null;
    after_date: string | null;
  }>(
    await db.execute(sql`
      select e.id::text, e.title_en as title, d.name as district, e.area_ha, e.properties #>> '{waterway,kind}' as kind,
        e.properties #>> '{waterway,name}' as wname, e.confidence,
        (select min(acquired_at)::date::text from image_references i where i.change_event_id = e.id and i.role = 'before') as before_date,
        (select max(acquired_at)::date::text from image_references i where i.change_event_id = e.id and i.role = 'latest') as after_date
      from change_events e left join admin_boundaries d on d.id = e.district_id
      where e.status <> 'dismissed' and e.properties ? 'waterway'
      order by case e.properties #>> '{waterway,kind}' when 'wetland' then 0 when 'drain' then 1 when 'canal' then 2 else 3 end, e.area_ha desc nulls last
      limit ${limit}`),
  ).map((r) => ({
    id: r.id,
    title: r.title,
    district: r.district,
    areaHa: Number(r.area_ha ?? 0),
    waterwayKind: r.kind,
    waterwayName: r.wname,
    shown: r.confidence !== "low",
    beforeDate: r.before_date,
    afterDate: r.after_date,
  }));
  const counts = Object.fromEntries(
    toRows<{ kind: string; n: number }>(
      await db.execute(sql`select properties #>> '{waterway,kind}' as kind, count(*)::int as n from change_events where status <> 'dismissed' and properties ? 'waterway' group by 1`),
    ).map((r) => [r.kind, Number(r.n)]),
  );
  return { items, counts };
}
