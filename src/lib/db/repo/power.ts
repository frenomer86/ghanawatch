import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "../client";

/**
 * Reading the power-cut reports. Everything here is counted from what people reported; nothing is
 * estimated from outside data. A district is "reported off" when its latest report in the last 12 hours
 * says lights off; hours off are added up from each "off" report to the next "on" report in the same
 * district, an interval with no "on" report counting at most 12 hours.
 */
const OPEN_CAP_H = 12;

export interface PowerPoint {
  lat: number;
  lon: number;
  off: number;
  on: number;
  last: string;
  lastKind: "off" | "on";
}

/** Reports in the last `hours`, grouped on a grid of about 2 km so no single report can be pinpointed. */
export async function powerPoints(hours: number): Promise<PowerPoint[]> {
  const db = await getDb();
  return toRows<{ lat: number; lon: number; off: number; on: number; last: string; last_kind: "off" | "on" }>(
    await db.execute(sql`
      select round(lat / 0.02) * 0.02 as lat, round(lon / 0.02) * 0.02 as lon,
        count(*) filter (where kind = 'off')::int as off, count(*) filter (where kind = 'on')::int as on,
        max(happened_at)::text as last,
        (array_agg(kind order by happened_at desc))[1] as last_kind
      from power_reports where happened_at >= now() - make_interval(hours => ${hours})
      group by 1, 2`),
  ).map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), off: r.off, on: r.on, last: new Date(r.last).toISOString(), lastKind: r.last_kind }));
}

export interface DistrictPower {
  districtId: string;
  district: string;
  region: string | null;
  status: "off" | "on";
  since: string;
  reportsToday: number;
  reporters: number;
  hoursOffWeek: number;
}

export async function districtPower(): Promise<DistrictPower[]> {
  const db = await getDb();
  const rs = toRows<{ district_id: string; district: string; region: string | null; kind: "off" | "on"; at: string; ip: string }>(
    await db.execute(sql`
      select r.district_id, d.name as district, p.name as region, r.kind, r.happened_at::text as at, r.ip_hash as ip
      from power_reports r
      join admin_boundaries d on d.id = r.district_id
      left join admin_boundaries p on p.id = d.parent_id
      where r.happened_at >= now() - interval '7 days'
      order by r.district_id, r.happened_at`),
  );
  const now = Date.now();
  const by = new Map<string, typeof rs>();
  for (const r of rs) by.set(r.district_id, [...(by.get(r.district_id) ?? []), r]);
  const out: DistrictPower[] = [];
  for (const list of by.values()) {
    let offMs = 0;
    let openAt: number | null = null;
    for (const r of list) {
      const t = new Date(r.at).getTime();
      if (r.kind === "off" && openAt == null) openAt = t;
      if (r.kind === "on" && openAt != null) {
        offMs += Math.min(t - openAt, OPEN_CAP_H * 3_600_000);
        openAt = null;
      }
    }
    if (openAt != null) offMs += Math.min(now - openAt, OPEN_CAP_H * 3_600_000);
    const last = list[list.length - 1];
    const lastT = new Date(last.at).getTime();
    const today = list.filter((r) => now - new Date(r.at).getTime() < 24 * 3_600_000);
    out.push({
      districtId: last.district_id,
      district: last.district,
      region: last.region,
      status: last.kind === "off" && now - lastT < OPEN_CAP_H * 3_600_000 ? "off" : "on",
      since: new Date(lastT).toISOString(),
      reportsToday: today.length,
      reporters: new Set(today.map((r) => r.ip)).size,
      hoursOffWeek: Math.round((offMs / 3_600_000) * 10) / 10,
    });
  }
  return out.sort((a, b) => (a.status === b.status ? b.hoursOffWeek - a.hoursOffWeek : a.status === "off" ? -1 : 1));
}
