import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "../client";
import { FIRST_CONFIRMED } from "@/lib/server/index/first-confirmed";
import {
  buildDistrictCards,
  buildReserveCards,
  scoreKind,
  slugify,
  type DistrictCard,
  type DistrictInfo,
  type ReserveCard,
  type ScoreEventRow,
} from "@/lib/domain/scorecards";
import type { Severity } from "@/lib/domain/types";
import { TtlCache } from "@/lib/server/explore/cache";

/**
 * Scorecards for every district and forest reserve, built from the live
 * database and kept for ten minutes per server process (the pipeline adds
 * detections a few times a day).
 */
export interface Scorecards {
  computedAt: string;
  districts: DistrictCard[];
  reserves: ReserveCard[];
  national: NationalTotals;
  /** True once fire points have districts, so "usual for this week" can be shown. */
  fireArchive: boolean;
}

export interface NationalTotals {
  miningHa: number;
  miningSites: number;
  radarHa: number;
  clearedHa: number;
  inReservesHa: number;
  reservesAffected: number;
  nearPeople: number;
  muddyRivers: number;
  districtsWithMining: number;
  newThisMonthHa: number;
  fires7d: number;
  firesUsual7d: number | null;
  floodAlerts: number;
}

const cache = new TtlCache<Scorecards>(4, 10 * 60_000);

export function scorecards(now: Date = new Date()): Promise<Scorecards> {
  return cache.get("all", () => compute(now));
}

interface EventRow {
  district_id: string;
  type: string;
  method_version: string;
  sig: string | null;
  confidence: string;
  severity: Severity;
  ha: number | null;
  reserve: string | null;
  mine: string | null;
  near: boolean;
  detected_at: string | Date;
  seen_on: string | Date | null;
  created_at: string | Date;
}

export async function loadEvents(): Promise<ScoreEventRow[]> {
  const db = await getDb();
  const rows = toRows<EventRow>(
    await db.execute(sql`
      select district_id, type, method_version, properties->>'signature' as sig, confidence, severity, area_ha::float as ha,
        properties->'placement'->>'protectedArea' as reserve, properties->'placement'->>'mine' as mine,
        (coalesce(properties->'placement'->>'inResidential', 'false') = 'true'
          or exists (select 1 from jsonb_array_elements(coalesce(properties->'placement'->'nearby', '[]'::jsonb)) x
            where x->>'kind' in ('school', 'cemetery', 'health') and (x->>'distanceM')::int <= 300)) as near,
        detected_at, created_at,
        case when method_version like 's2-galamsey-3.%' then coalesce(to_date(fc.m || '-01', 'YYYY-MM-DD'), created_at::date)
          else coalesce(first_image_date, image_date) end as seen_on
      from change_events
      left join ${FIRST_CONFIRMED} fc on fc.source_event_id = change_events.source_event_id and change_events.method_version like 's2-galamsey-3.%'
      where status <> 'dismissed' and district_id is not null`),
  );
  return rows.map((r) => ({
    districtId: r.district_id,
    type: r.type,
    methodVersion: r.method_version,
    signature: r.sig,
    confidence: r.confidence,
    severity: r.severity,
    areaHa: Number(r.ha ?? 0),
    reserve: r.reserve,
    mine: r.mine,
    nearPeople: Boolean(r.near),
    detectedAt: new Date(r.detected_at),
    // The first satellite date the site was seen (never moved forward by a rescan), so a site re-seen this
    // month is not counted as new this month. For the multi-sensor record: the month it was first confirmed
    // (its onset, when mining began, is usually months earlier), or the day it was first published.
    firstSeen: new Date(r.seen_on ?? r.created_at),
  }));
}

export async function loadDistrictInfo(): Promise<DistrictInfo[]> {
  const db = await getDb();
  return toRows<{ id: string; name: string; region: string | null; area: number | null }>(
    await db.execute(sql`
      select d.id, d.name, r.name as region, d.area_km2::float as area
      from admin_boundaries d left join admin_boundaries r on r.id = d.parent_id
      where d.level = 'district'`),
  ).map((d): DistrictInfo => ({ id: d.id, name: d.name, region: d.region, areaKm2: d.area == null ? null : Number(d.area) }));
}

async function compute(now: Date): Promise<Scorecards> {
  const db = await getDb();
  const districts = await loadDistrictInfo();
  const events = await loadEvents();

  const since7 = new Date(now.getTime() - 7 * 86_400_000);
  const fires7d = new Map<string, number>();
  for (const e of events) if (e.type === "fire" && e.detectedAt >= since7 && e.districtId) fires7d.set(e.districtId, (fires7d.get(e.districtId) ?? 0) + 1);

  // Usual for the same seven days of the year, from the 2020–2025 VIIRS archive.
  const doy = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  const [{ placed }] = toRows<{ placed: number }>(await db.execute(sql`select count(*)::int as placed from fire_points where district_id is not null`));
  let firesUsual7d: Map<string, number> | null = null;
  if (Number(placed) > 0) {
    firesUsual7d = new Map(
      toRows<{ d: string; usual: number }>(
        await db.execute(sql`
          select district_id as d, count(*)::float / 6 as usual from fire_points
          where district_id is not null and acq_date >= '2020-01-01' and acq_date < '2026-01-01'
            and ((${doy} - extract(doy from acq_date)::int + 366) % 366) <= 6
          group by 1`),
      ).map((r) => [r.d, Number(r.usual)]),
    );
  }
  const reports = new Map(
    toRows<{ d: string; approved: number; confirmed: number }>(
      await db.execute(sql`
        select district_id as d, count(*)::int as approved, count(*) filter (where satellite_verdict = 'confirmed_by_satellite')::int as confirmed
        from community_reports where status = 'approved' and district_id is not null group by 1`),
    ).map((r) => [r.d, { approved: Number(r.approved), confirmed: Number(r.confirmed) }]),
  );

  const cards = buildDistrictCards({ districts, events, fires7d, firesUsual7d, reports, now });
  const names = new Map(districts.map((d) => [d.id, d.name]));
  const reserves = buildReserveCards(events, names);
  const sum = (f: (c: DistrictCard) => number) => Math.round(cards.reduce((s, c) => s + f(c), 0) * 10) / 10;
  return {
    computedAt: now.toISOString(),
    districts: cards,
    reserves,
    fireArchive: firesUsual7d !== null,
    national: {
      miningHa: sum((c) => c.miningHa),
      miningSites: sum((c) => c.miningSites),
      radarHa: sum((c) => c.radarHa),
      clearedHa: sum((c) => c.clearedHa),
      inReservesHa: sum((c) => c.inReservesHa),
      reservesAffected: reserves.length,
      nearPeople: sum((c) => c.nearPeople),
      muddyRivers: sum((c) => c.muddyRivers),
      districtsWithMining: cards.filter((c) => c.miningHa > 0).length,
      newThisMonthHa: sum((c) => c.newThisMonthHa),
      fires7d: sum((c) => c.fires7d),
      firesUsual7d: firesUsual7d ? sum((c) => c.firesUsual7d ?? 0) : null,
      floodAlerts: sum((c) => c.floodAlerts),
    },
  };
}

export interface DistrictDetail {
  card: DistrictCard;
  total: number;
  forestLoss: Array<{ year: number; ha: number }>;
  firesByYear: Array<{ year: number; fires: number }>;
  topSites: Array<{ id: string; title: string; areaHa: number; confidence: string; severity: Severity; imageDate: string | null; flags: string[]; lat: number; lon: number }>;
  bbox: [number, number, number, number] | null;
}

export async function districtBySlug(slug: string): Promise<DistrictDetail | null> {
  const all = await scorecards();
  const card = all.districts.find((c) => c.slug === slug);
  if (!card) return null;
  const db = await getDb();
  const forestLoss = toRows<{ year: number; ha: number }>(
    await db.execute(sql`select year, loss_ha::float as ha from district_forest_loss where district_id = ${card.id} order by year`),
  ).map((r) => ({ year: Number(r.year), ha: Number(r.ha) }));
  const firesByYear = toRows<{ year: number; fires: number }>(
    await db.execute(sql`
      select extract(year from acq_date)::int as year, count(*)::int as fires from fire_points
      where district_id = ${card.id} group by 1 order by 1`),
  ).map((r) => ({ year: Number(r.year), fires: Number(r.fires) }));
  const sites = toRows<{ id: string; title: string; ha: number; confidence: string; severity: Severity; image_date: string | null; type: string; method_version: string; sig: string | null; flags: string[] | null; lat: number; lon: number }>(
    await db.execute(sql`
      select id, title_en as title, area_ha::float as ha, confidence, severity, image_date::text as image_date, type, method_version,
        centroid_lat::float as lat, centroid_lon::float as lon,
        properties->>'signature' as sig, properties->'placement'->'flags' as flags
      from change_events
      where district_id = ${card.id} and status <> 'dismissed' and properties->'placement'->>'mine' is null
        and (method_version like 's2-galamsey-%' or method_version like 's1-water-%')
      order by area_ha desc nulls last limit 60`),
  );
  const topSites = sites
    .filter((s) => scoreKind({ type: s.type, methodVersion: s.method_version, signature: s.sig, confidence: s.confidence }).likely)
    .slice(0, 8)
    .map((s) => ({ id: s.id, title: s.title, areaHa: Number(s.ha), confidence: s.confidence, severity: s.severity, imageDate: s.image_date, flags: (s.flags ?? []).slice(0, 2), lat: Number(s.lat), lon: Number(s.lon) }));
  const [b] = toRows<{ a: number; b: number; c: number; d: number }>(
    await db.execute(sql`select bbox_min_lon::float as a, bbox_min_lat::float as b, bbox_max_lon::float as c, bbox_max_lat::float as d from admin_boundaries where id = ${card.id}`),
  );
  return {
    card,
    total: all.districts.length,
    forestLoss,
    firesByYear,
    topSites,
    bbox: b ? [Number(b.a), Number(b.b), Number(b.c), Number(b.d)] : null,
  };
}

export async function reserveBySlug(slug: string): Promise<{ card: ReserveCard; sites: DistrictDetail["topSites"] } | null> {
  const all = await scorecards();
  const card = all.reserves.find((r) => r.slug === slug);
  if (!card) return null;
  const db = await getDb();
  const sites = toRows<{ id: string; title: string; ha: number; confidence: string; severity: Severity; image_date: string | null; type: string; method_version: string; sig: string | null; flags: string[] | null; lat: number; lon: number }>(
    await db.execute(sql`
      select id, title_en as title, area_ha::float as ha, confidence, severity, image_date::text as image_date, type, method_version,
        properties->>'signature' as sig, properties->'placement'->'flags' as flags, centroid_lat::float as lat, centroid_lon::float as lon
      from change_events
      where status <> 'dismissed' and properties->'placement'->>'protectedArea' = ${card.name} and properties->'placement'->>'mine' is null
        and ((method_version like 's2-galamsey-%' and type = 'surface_disturbance') or method_version like 's1-water-%')
      order by area_ha desc nulls last limit 40`),
  );
  return {
    card,
    sites: sites
      .filter((s) => {
        const k = scoreKind({ type: s.type, methodVersion: s.method_version, signature: s.sig, confidence: s.confidence });
        return k.likely || k.kind === "cleared";
      })
      .slice(0, 12)
      .map((s) => ({ id: s.id, title: s.title, areaHa: Number(s.ha), confidence: s.confidence, severity: s.severity, imageDate: s.image_date, flags: (s.flags ?? []).slice(0, 2), lat: Number(s.lat), lon: Number(s.lon) })),
  };
}

export { slugify };
