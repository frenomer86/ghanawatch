import { sql } from "drizzle-orm";
import { slugify } from "@/lib/domain/scorecards";
import { isSignificant, type CoastPoint } from "@/lib/domain/coast";
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

/** A district's stretch of coast: kilometres measured, how many are retreating, and the fastest retreat. */
export async function districtCoast(districtId: string): Promise<{ km: number; retreatingKm: number; worstRate: number | null; worstPlace: string | null } | null> {
  const db = await getDb();
  const rs = toRows<{ rate_m_yr: number; sig: number | null; certainty: string; place: string | null }>(
    await db.execute(sql`select rate_m_yr, sig, certainty, place from coast_points where district_id = ${districtId}`),
  );
  if (!rs.length) return null;
  const pts = rs.map((r) => ({ rateMYr: Number(r.rate_m_yr), sig: r.sig == null ? null : Number(r.sig), certainty: r.certainty, place: r.place }));
  const retreating = pts.filter((p) => isSignificant(p) && p.rateMYr < 0).sort((a, b) => a.rateMYr - b.rateMYr);
  return { km: pts.length, retreatingKm: retreating.length, worstRate: retreating[0]?.rateMYr ?? null, worstPlace: retreating[0]?.place ?? null };
}
