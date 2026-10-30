import { and, asc, eq, ilike, sql } from "drizzle-orm";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import { getDb } from "../client";
import { adminBoundaries } from "../schema";
import { pointInPolygon } from "@/lib/geo";

export interface BoundarySummary {
  id: string;
  level: "region" | "district";
  code: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  centroid: { lon: number; lat: number };
  bbox: [number, number, number, number];
}

function toSummary(r: typeof adminBoundaries.$inferSelect, parentName: string | null = null): BoundarySummary {
  return {
    id: r.id,
    level: r.level as "region" | "district",
    code: r.code,
    name: r.name,
    parentId: r.parentId,
    parentName,
    centroid: { lon: r.centroidLon ?? 0, lat: r.centroidLat ?? 0 },
    bbox: [r.bboxMinLon ?? 0, r.bboxMinLat ?? 0, r.bboxMaxLon ?? 0, r.bboxMaxLat ?? 0],
  };
}

export async function listRegions(): Promise<BoundarySummary[]> {
  const db = await getDb();
  const rows = await db.select().from(adminBoundaries).where(eq(adminBoundaries.level, "region")).orderBy(asc(adminBoundaries.name));
  return rows.map((r) => toSummary(r));
}

export async function listDistricts(regionId?: string): Promise<BoundarySummary[]> {
  const db = await getDb();
  const parent = db.$with("parent").as(db.select({ id: adminBoundaries.id, name: adminBoundaries.name }).from(adminBoundaries));
  const rows = await db
    .with(parent)
    .select({ b: adminBoundaries, parentName: parent.name })
    .from(adminBoundaries)
    .leftJoin(parent, eq(parent.id, adminBoundaries.parentId))
    .where(
      and(eq(adminBoundaries.level, "district"), regionId ? eq(adminBoundaries.parentId, regionId) : undefined),
    )
    .orderBy(asc(adminBoundaries.name));
  return rows.map((r) => toSummary(r.b, r.parentName));
}

/** Every district name, sorted, for the "find your district" box. */
export async function listDistrictNames(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select({ name: adminBoundaries.name }).from(adminBoundaries).where(eq(adminBoundaries.level, "district")).orderBy(asc(adminBoundaries.name));
  return rows.map((r) => r.name);
}

/** Escape LIKE metacharacters so user input can never widen the pattern. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function searchBoundaries(q: string, limit = 8): Promise<BoundarySummary[]> {
  const db = await getDb();
  const pattern = `%${escapeLike(q)}%`;
  const parent = db.$with("parent").as(db.select({ id: adminBoundaries.id, name: adminBoundaries.name }).from(adminBoundaries));
  const rows = await db
    .with(parent)
    .select({ b: adminBoundaries, parentName: parent.name })
    .from(adminBoundaries)
    .leftJoin(parent, eq(parent.id, adminBoundaries.parentId))
    .where(ilike(adminBoundaries.name, pattern))
    .orderBy(
      // exact prefix matches first, then regions before districts, then alphabetical
      sql`case when lower(${adminBoundaries.name}) like lower(${`${escapeLike(q)}%`}) then 0 else 1 end`,
      asc(adminBoundaries.level),
      asc(adminBoundaries.name),
    )
    .limit(limit);
  return rows.map((r) => toSummary(r.b, r.parentName));
}

export async function getBoundary(id: string): Promise<(BoundarySummary & { geometry: Geometry | null }) | null> {
  const db = await getDb();
  const [row] = await db.select().from(adminBoundaries).where(eq(adminBoundaries.id, id)).limit(1);
  if (!row) return null;
  let parentName: string | null = null;
  if (row.parentId) {
    const [p] = await db.select({ name: adminBoundaries.name }).from(adminBoundaries).where(eq(adminBoundaries.id, row.parentId));
    parentName = p?.name ?? null;
  }
  return { ...toSummary(row, parentName), geometry: row.geom ?? null };
}

/** District containing a point: bbox pre-filter in SQL, exact point-in-polygon in JS. */
export async function districtContaining(lon: number, lat: number): Promise<BoundarySummary | null> {
  const db = await getDb();
  const candidates = await db
    .select()
    .from(adminBoundaries)
    .where(
      and(
        eq(adminBoundaries.level, "district"),
        sql`${adminBoundaries.bboxMinLon} <= ${lon}`,
        sql`${adminBoundaries.bboxMaxLon} >= ${lon}`,
        sql`${adminBoundaries.bboxMinLat} <= ${lat}`,
        sql`${adminBoundaries.bboxMaxLat} >= ${lat}`,
      ),
    );
  for (const c of candidates) {
    const g = c.geom;
    if (g && (g.type === "Polygon" || g.type === "MultiPolygon") && pointInPolygon([lon, lat], g as Polygon | MultiPolygon)) {
      let parentName: string | null = null;
      if (c.parentId) {
        const [p] = await db.select({ name: adminBoundaries.name }).from(adminBoundaries).where(eq(adminBoundaries.id, c.parentId));
        parentName = p?.name ?? null;
      }
      return toSummary(c, parentName);
    }
  }
  return null;
}

export async function countBoundaries(): Promise<{ regions: number; districts: number }> {
  const db = await getDb();
  const rows = await db
    .select({ level: adminBoundaries.level, n: sql<number>`count(*)::int` })
    .from(adminBoundaries)
    .groupBy(adminBoundaries.level);
  const out = { regions: 0, districts: 0 };
  for (const r of rows) {
    if (r.level === "region") out.regions = Number(r.n);
    if (r.level === "district") out.districts = Number(r.n);
  }
  return out;
}
