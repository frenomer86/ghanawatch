import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "@/lib/db/client";
import { INDEX_VERSION, monthLabel, previousMonth, rankMovement } from "@/lib/domain/index";
import { slugify } from "@/lib/domain/scorecards";
import { TtlCache } from "@/lib/server/explore/cache";

/**
 * Reading the frozen index. Everything public (home page, district pages, rankings, API, cards, reports)
 * reads from here, never from the live detections, so a number quoted from the site can be found again in
 * the release files.
 */
export interface NationalMonth {
  month: string;
  label: string;
  newHa: number;
  cumHa: number;
  ciLow: number | null;
  ciHigh: number | null;
  newSites: number;
  districtsAffected: number;
  topDistrict: { id: string; name: string; slug: string; region: string | null } | null;
  inReservesHa: number;
  closedAt: string;
}

export interface DistrictMonth {
  districtId: string;
  name: string;
  slug: string;
  region: string | null;
  areaKm2: number | null;
  month: string;
  newHa: number;
  cumHa: number;
  index: number;
  rank: number | null;
  rankBefore: number | null;
  movement: ReturnType<typeof rankMovement>;
  newSites: number;
  activeSites: number;
  pctForest: number | null;
  pctRiver: number | null;
  pctUnlicensed: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

const cache = new TtlCache<unknown>(64, 5 * 60_000);
export function clearIndexCache() {
  cache.clear();
}

interface NatRow {
  month: string;
  new_ha: number;
  cum_ha: number;
  ci_low: number | null;
  ci_high: number | null;
  new_sites: number;
  districts_affected: number;
  top_id: string | null;
  top_name: string | null;
  top_region: string | null;
  in_reserves_ha: number;
  closed_at: string;
}

function natRow(r: NatRow): NationalMonth {
  return {
    month: r.month,
    label: monthLabel(r.month),
    newHa: Number(r.new_ha),
    cumHa: Number(r.cum_ha),
    ciLow: r.ci_low == null ? null : Number(r.ci_low),
    ciHigh: r.ci_high == null ? null : Number(r.ci_high),
    newSites: Number(r.new_sites),
    districtsAffected: Number(r.districts_affected),
    topDistrict: r.top_id ? { id: r.top_id, name: r.top_name ?? "", slug: slugify(r.top_name ?? ""), region: r.top_region } : null,
    inReservesHa: Number(r.in_reserves_ha),
    closedAt: String(r.closed_at),
  };
}

/** Every closed month, oldest first. Empty until the first month is closed. */
export function nationalSeries(version = INDEX_VERSION): Promise<NationalMonth[]> {
  return cache.get(`national:${version}`, async () => {
    const db = await getDb();
    return toRows<NatRow>(
      await db.execute(sql`
        select n.month, n.new_ha, n.cum_ha, n.ci_low, n.ci_high, n.new_sites, n.districts_affected, n.in_reserves_ha, n.closed_at::text,
          d.id::text as top_id, d.name as top_name, r.name as top_region
        from national_months n
        left join admin_boundaries d on d.id = n.top_district_id
        left join admin_boundaries r on r.id = d.parent_id
        where n.index_version = ${version} order by n.month`),
    ).map(natRow);
  }) as Promise<NationalMonth[]>;
}

export async function latestClosedMonth(version = INDEX_VERSION): Promise<NationalMonth | null> {
  const s = await nationalSeries(version);
  return s.at(-1) ?? null;
}

export async function nationalMonth(month: string, version = INDEX_VERSION): Promise<NationalMonth | null> {
  const s = await nationalSeries(version);
  return s.find((m) => m.month === month) ?? null;
}

interface DistRow {
  district_id: string;
  name: string;
  region: string | null;
  area_km2: number | null;
  month: string;
  new_ha: number;
  cum_ha: number;
  index: number;
  rank: number | null;
  new_sites: number;
  active_sites: number;
  pct_forest: number | null;
  pct_river: number | null;
  pct_unlicensed: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

function distRow(r: DistRow, rankBefore: number | null): DistrictMonth {
  const rank = r.rank == null ? null : Number(r.rank);
  return {
    districtId: r.district_id,
    name: r.name,
    slug: slugify(r.name),
    region: r.region,
    areaKm2: r.area_km2 == null ? null : Number(r.area_km2),
    month: r.month,
    newHa: Number(r.new_ha),
    cumHa: Number(r.cum_ha),
    index: Number(r.index),
    rank,
    rankBefore,
    movement: rankMovement(rank, rankBefore),
    newSites: Number(r.new_sites),
    activeSites: Number(r.active_sites),
    pctForest: r.pct_forest == null ? null : Number(r.pct_forest),
    pctRiver: r.pct_river == null ? null : Number(r.pct_river),
    pctUnlicensed: r.pct_unlicensed == null ? null : Number(r.pct_unlicensed),
    ciLow: r.ci_low == null ? null : Number(r.ci_low),
    ciHigh: r.ci_high == null ? null : Number(r.ci_high),
  };
}

const DIST_SELECT = sql`
  select m.district_id::text, d.name, r.name as region, d.area_km2::float as area_km2, m.month, m.new_ha, m.cum_ha, m.index, m.rank,
    m.new_sites, m.active_sites, m.pct_forest, m.pct_river, m.pct_unlicensed, m.ci_low, m.ci_high
  from district_months m
  join admin_boundaries d on d.id = m.district_id
  left join admin_boundaries r on r.id = d.parent_id`;

/** Every district for one closed month, ranked (rank 1 first), unranked districts after, by name. */
export function rankings(month: string, version = INDEX_VERSION): Promise<DistrictMonth[]> {
  return cache.get(`rankings:${version}:${month}`, async () => {
    const db = await getDb();
    const prev = previousMonth(month);
    const rows = toRows<DistRow>(await db.execute(sql`${DIST_SELECT} where m.index_version = ${version} and m.month in (${month}, ${prev})`));
    const before = new Map(rows.filter((r) => r.month === prev).map((r) => [r.district_id, r.rank == null ? null : Number(r.rank)]));
    return rows
      .filter((r) => r.month === month)
      .map((r) => distRow(r, before.get(r.district_id) ?? null))
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  }) as Promise<DistrictMonth[]>;
}

/** One district's whole closed series, oldest first. */
export function districtSeries(districtId: string, version = INDEX_VERSION): Promise<DistrictMonth[]> {
  return cache.get(`district:${version}:${districtId}`, async () => {
    const db = await getDb();
    const rows = toRows<DistRow>(await db.execute(sql`${DIST_SELECT} where m.index_version = ${version} and m.district_id = ${districtId} order by m.month`));
    const out: DistrictMonth[] = [];
    let before: number | null = null;
    for (const r of rows) {
      const d = distRow(r, before);
      out.push(d);
      before = d.rank;
    }
    return out;
  }) as Promise<DistrictMonth[]>;
}

export async function districtMonth(districtId: string, month: string, version = INDEX_VERSION): Promise<DistrictMonth | null> {
  const s = await districtSeries(districtId, version);
  return s.find((m) => m.month === month) ?? null;
}

export interface ReleaseRow {
  month: string;
  indexVersion: string;
  publishedAt: string;
  dryRun: boolean;
  doi: string | null;
  headline: string;
  manifest: Record<string, unknown>;
}

export function releasesList(): Promise<ReleaseRow[]> {
  return cache.get("releases", async () => {
    const db = await getDb();
    return toRows<{ month: string; index_version: string; published_at: string; dry_run: boolean; doi: string | null; headline: string; manifest: Record<string, unknown> }>(
      await db.execute(sql`select month, index_version, published_at::text, dry_run, doi, headline, manifest from releases where not dry_run order by month desc, published_at desc`),
    ).map((r) => ({ month: r.month, indexVersion: r.index_version, publishedAt: String(r.published_at), dryRun: Boolean(r.dry_run), doi: r.doi, headline: r.headline, manifest: r.manifest ?? {} }));
  }) as Promise<ReleaseRow[]>;
}

export async function releaseFor(month: string): Promise<ReleaseRow | null> {
  const list = await releasesList();
  return list.find((r) => r.month === month) ?? null;
}
