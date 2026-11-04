import { sql } from "drizzle-orm";
import { slugify } from "@/lib/domain/scorecards";
import type { CoastPoint } from "@/lib/domain/coast";
import { getDb, rows as toRows } from "../client";

export interface CoastPointRow extends CoastPoint {
  district: string | null;
  districtSlug: string | null;
}

/** Every coastline point with its district, west to east. */
export async function coastPointsAll(): Promise<CoastPointRow[]> {
  const db = await getDb();
  const rs = toRows<{
    lon: number;
    lat: number;
    rate_m_yr: number;
    sig: number | null;
    certainty: string;
    change_m: number | null;
    latest_year: number | null;
    place: string | null;
    district_id: string | null;
    district: string | null;
  }>(
    await db.execute(sql`
      select c.lon, c.lat, c.rate_m_yr, c.sig, c.certainty, c.change_m, c.latest_year, c.place, c.district_id, d.name as district
      from coast_points c left join admin_boundaries d on d.id = c.district_id
      order by c.lon`),
  );
  return rs.map((r) => ({
    lon: Number(r.lon),
    lat: Number(r.lat),
    rateMYr: Number(r.rate_m_yr),
    sig: r.sig == null ? null : Number(r.sig),
    certainty: r.certainty,
    changeM: r.change_m == null ? null : Number(r.change_m),
    latestYear: r.latest_year == null ? null : Number(r.latest_year),
    place: r.place,
    districtId: r.district_id,
    district: r.district,
    districtSlug: r.district ? slugify(r.district) : null,
  }));
}
