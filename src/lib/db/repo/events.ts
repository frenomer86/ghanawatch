import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Geometry } from "geojson";
import { getDb, rows as toRows } from "../client";
import { adminBoundaries, changeEvents, dataSources, imageReferences } from "../schema";
import type { BBox, ChangeEventDetail, ChangeEventSummary, ChangeType, Confidence, EventStatus, Locale, Severity } from "@/lib/domain/types";
import { encodeCursor, type EventsQuery } from "@/lib/domain/validation";
import { escapeLike } from "./boundaries";
import { env } from "@/lib/server/env";

type Row = {
  e: typeof changeEvents.$inferSelect;
  s: { slug: string; name: string; url: string; licence: string; attributionText: string };
  districtName: string | null;
  regionName: string | null;
};

function pickLocale(en: string, tw: string | null, locale: Locale) {
  return locale === "tw" && tw ? tw : en;
}

export function toSummary(r: Row, locale: Locale = "en"): ChangeEventSummary {
  const e = r.e;
  return {
    id: e.id,
    type: e.type as ChangeType,
    severity: e.severity as Severity,
    confidence: e.confidence as Confidence,
    detectedAt: e.detectedAt.toISOString(),
    imageDate: e.imageDate,
    imageDateEnd: e.imageDateEnd,
    areaHa: e.areaHa,
    districtName: r.districtName,
    regionName: r.regionName,
    centroid: { lon: e.centroidLon ?? 0, lat: e.centroidLat ?? 0 },
    title: pickLocale(e.titleEn, e.titleTw, locale),
    sourceSlug: r.s.slug,
    sourceName: r.s.name,
    status: e.status as EventStatus,
    flags: [
      ...((e.properties as { licensedMine?: string } | null)?.licensedMine ? [`Inside a licensed mine: ${(e.properties as { licensedMine: string }).licensedMine}`] : []),
      ...((e.properties as { placement?: { flags?: string[] } } | null)?.placement?.flags ?? []),
    ].slice(0, 4),
    track: trackOf(e.properties),
  };
}

function trackOf(p: Record<string, unknown> | null): ChangeEventSummary["track"] {
  if (p?.signature !== "new_road" || typeof p.lengthM !== "number") return null;
  return { lengthM: p.lengthM, widthM: Number(p.widthM ?? 0) };
}

function baseSelect(db: Awaited<ReturnType<typeof getDb>>) {
  const district = db.$with("district").as(
    db
      .select({ id: adminBoundaries.id, name: adminBoundaries.name, parentId: adminBoundaries.parentId })
      .from(adminBoundaries)
      .where(eq(adminBoundaries.level, "district")),
  );
  const region = db.$with("region").as(
    db.select({ id: adminBoundaries.id, name: adminBoundaries.name }).from(adminBoundaries).where(eq(adminBoundaries.level, "region")),
  );
  return { district, region };
}

export function buildFilters(q: Partial<EventsQuery> & { bbox?: BBox }, cols = changeEvents): SQL[] {
  const f: SQL[] = [];
  if (q.bbox) {
    const [minLon, minLat, maxLon, maxLat] = q.bbox;
    f.push(sql`${cols.bboxMaxLon} >= ${minLon}`, sql`${cols.bboxMinLon} <= ${maxLon}`);
    f.push(sql`${cols.bboxMaxLat} >= ${minLat}`, sql`${cols.bboxMinLat} <= ${maxLat}`);
  }
  // Time windows go by when the satellite saw the change (the latest image), not when it was imported.
  if (q.since) f.push(sql`coalesce(${cols.imageDateEnd}, ${cols.imageDate}) >= ${q.since.toISOString().slice(0, 10)}::date`);
  if (q.from) f.push(gte(cols.imageDate, q.from));
  if (q.to) f.push(lte(cols.imageDate, q.to));
  if (q.type) f.push(eq(cols.type, q.type));
  if (q.severity) f.push(eq(cols.severity, q.severity));
  if (q.confidence) f.push(eq(cols.confidence, q.confidence));
  // Views show what is likely by default; single-source "possible" detections only on request and in downloads.
  else if (q.possible !== "1" && q.format !== "csv" && q.format !== "geojson") f.push(sql`${cols.confidence} <> 'low'`);
  f.push(sql`${cols.status} <> 'dismissed'`);
  return f;
}

export async function listEvents(
  q: EventsQuery,
  locale: Locale = "en",
): Promise<{ items: ChangeEventSummary[]; nextCursor: string | null }> {
  const db = await getDb();
  const { district, region } = baseSelect(db);
  const filters = buildFilters(q);
  if (q.district) filters.push(sql`${district.name} ilike ${escapeLike(q.district)}`);
  if (q.region) filters.push(sql`${region.name} ilike ${escapeLike(q.region)}`);
  if (q.cursor) {
    const ts = new Date(q.cursor.ts);
    filters.push(
      or(
        lt(changeEvents.detectedAt, ts),
        and(eq(changeEvents.detectedAt, ts), sql`${changeEvents.id} < ${q.cursor.id}`),
      )!,
    );
  }
  const rows = await db
    .with(district, region)
    .select({
      e: changeEvents,
      s: {
        slug: dataSources.slug,
        name: dataSources.name,
        url: dataSources.url,
        licence: dataSources.licence,
        attributionText: dataSources.attributionText,
      },
      districtName: district.name,
      regionName: region.name,
    })
    .from(changeEvents)
    .innerJoin(dataSources, eq(dataSources.id, changeEvents.sourceId))
    .leftJoin(district, eq(district.id, changeEvents.districtId))
    .leftJoin(region, eq(region.id, district.parentId))
    .where(and(...filters))
    .orderBy(desc(changeEvents.detectedAt), desc(changeEvents.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toSummary(r, locale)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.e.detectedAt, last.e.id) : null,
  };
}

/** Streams every matching row for exports; the caller bounds the total. */
export async function* iterateEvents(q: EventsQuery, locale: Locale = "en", maxRows = 50_000) {
  let cursor = q.cursor;
  let emitted = 0;
  while (emitted < maxRows) {
    const limit = Math.min(500, maxRows - emitted);
    const page = await listEvents({ ...q, limit, cursor }, locale);
    for (const item of page.items) {
      yield item;
      emitted++;
    }
    if (!page.nextCursor) return;
    const decoded = Buffer.from(page.nextCursor, "base64url").toString("utf8").split("|");
    cursor = { ts: decoded[0], id: decoded[1] };
  }
}

/**
 * The public description: what was seen, when and how sure, in plain words. The stored description (which
 * explains how the detection was made) stays internal.
 */
function publicDescription(e: typeof changeEvents.$inferSelect): string {
  const ha = e.areaHa != null ? ` (about ${e.areaHa >= 10 ? Math.round(e.areaHa) : Number(e.areaHa).toFixed(1)} ha)` : "";
  const when = e.imageDateEnd && e.imageDateEnd !== e.imageDate ? `between ${e.imageDate} and ${e.imageDateEnd}` : `on ${e.imageDate}`;
  const check = "It is a change seen from space, not a legal finding: check the before and after images, and report what you see on the ground.";
  switch (e.type) {
    case "surface_disturbance":
      return `Satellite images show ground opened up here${ha} ${when}: cleared vegetation, pits or ponds of the kind mining leaves. ${check}`;
    case "water_change":
      return `Satellite images show new or changed water here${ha} ${when}, such as new ponds or a river turning muddy. ${check}`;
    case "vegetation_loss":
      if (e.properties?.signature === "new_road") return trackDescription(e, when, check);
      return `Tree cover was lost here${ha} ${when}. Clearing for mining, farms, roads or fire all look like this from space. ${check}`;
    case "fire":
      return `A fire was seen here by satellite ${when}. The cause cannot be told from space; most are bush, farm or waste fires.`;
    default:
      return e.descriptionEn;
  }
}

/** A new track into forest (src/pipeline/context/roads.ts): its length, and the reserve it enters or approaches. */
function trackDescription(e: typeof changeEvents.$inferSelect, when: string, check: string): string {
  const p = (e.properties ?? {}) as { lengthM?: number; roadContext?: { reserve: string | null; inside: boolean; distanceM: number | null } };
  const len = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
  const ctx = p.roadContext;
  const where = ctx?.reserve ? (ctx.inside ? `, inside ${ctx.reserve}` : `, ${len(ctx.distanceM ?? 0)} from the edge of ${ctx.reserve}`) : "";
  return `A new track${p.lengthM ? ` about ${len(p.lengthM)} long` : ""} was cut through forest here${where}, seen ${when}. New tracks into forest often come before mining pits or logging; a line of clearing for pits can look the same from space. ${check}`;
}

export async function getEvent(id: string, locale: Locale = "en"): Promise<ChangeEventDetail | null> {
  const db = await getDb();
  const { district, region } = baseSelect(db);
  const [r] = await db
    .with(district, region)
    .select({
      e: changeEvents,
      s: {
        slug: dataSources.slug,
        name: dataSources.name,
        url: dataSources.url,
        licence: dataSources.licence,
        attributionText: dataSources.attributionText,
      },
      districtName: district.name,
      regionName: region.name,
    })
    .from(changeEvents)
    .innerJoin(dataSources, eq(dataSources.id, changeEvents.sourceId))
    .leftJoin(district, eq(district.id, changeEvents.districtId))
    .leftJoin(region, eq(region.id, district.parentId))
    .where(eq(changeEvents.id, id))
    .limit(1);
  if (!r) return null;

  const images = await db
    .select({ i: imageReferences, sourceName: dataSources.name })
    .from(imageReferences)
    .innerJoin(dataSources, eq(dataSources.id, imageReferences.sourceId))
    .where(eq(imageReferences.changeEventId, id))
    .orderBy(imageReferences.acquiredAt);

  const summary = toSummary(r, locale);
  const e = r.e;
  const origin = env().PUBLIC_ORIGIN;
  return {
    ...summary,
    description: publicDescription(e),
    geometry: (e.geom ?? { type: "Point", coordinates: [summary.centroid.lon, summary.centroid.lat] }) as Geometry,
    bbox: [e.bboxMinLon ?? 0, e.bboxMinLat ?? 0, e.bboxMaxLon ?? 0, e.bboxMaxLat ?? 0],
    // How a detection was made is not published.
    methodVersion: null,
    images: images.map(({ i, sourceName }) => ({
      role: i.role as "latest" | "before" | "after",
      productId: i.productId,
      sensor: i.sensor,
      acquiredAt: i.acquiredAt.toISOString(),
      cloudCoverPct: i.cloudCoverPct,
      thumbnailUrl: i.thumbnailUrl,
      licence: i.licence,
      sourceName,
    })),
    sourceUrl: r.s.url,
    sourceLicence: r.s.licence,
    sourceAttribution: r.s.attributionText,
    citation: `GhanaWatch (${new Date().getFullYear()}). Change event ${e.id}, ${e.type.replace("_", " ")}, image date ${e.imageDate}. Derived from ${r.s.name} (${r.s.licence}). ${origin}/event/${e.id}`,
  };
}

export interface GridCluster {
  key: string;
  /** Sites inside a mapped licensed mine: drawn grey, never counted as galamsey. */
  licensed: boolean;
  type: ChangeType;
  severity: Severity;
  count: number;
  areaHa: number | null;
  isNew: boolean;
  lon: number;
  lat: number;
  bbox: BBox;
  latestDetectedAt: string;
  latestImageDate: string;
  districtName: string | null;
  sampleId: string;
}

/**
 * Hotspots for the national map: events grouped on a lon/lat grid by type.
 * cellDeg 0.1 ≈ 11 km, suitable for zoom ≤ 8; the client requests smaller cells as it zooms.
 */
export async function gridHotspots(opts: {
  since: Date;
  bbox?: BBox;
  type?: ChangeType;
  severity?: Severity;
  possible?: "0" | "1";
  cellDeg: number;
  newSince: Date;
}): Promise<GridCluster[]> {
  const db = await getDb();
  const filters = buildFilters({ since: opts.since, bbox: opts.bbox, type: opts.type, severity: opts.severity, possible: opts.possible });
  const cell = opts.cellDeg;
  type GridRow = {
    gx: number;
    gy: number;
    type: string;
    licensed: boolean;
    n: number;
    area: number | null;
    lon: number;
    lat: number;
    min_lon: number;
    min_lat: number;
    max_lon: number;
    max_lat: number;
    sev: number;
    latest: string;
    latest_img: string;
    is_new: boolean;
    district_id: string | null;
    sample_id: string;
  };
  const result = await db.execute(sql`
    select floor(centroid_lon / ${cell}) as gx, floor(centroid_lat / ${cell}) as gy, type, (properties ? 'licensedMine') as licensed,
      count(*)::int as n, sum(area_ha) as area,
      avg(centroid_lon) as lon, avg(centroid_lat) as lat,
      min(bbox_min_lon) as min_lon, min(bbox_min_lat) as min_lat, max(bbox_max_lon) as max_lon, max(bbox_max_lat) as max_lat,
      max(case severity when 'urgent' then 3 when 'elevated' then 2 when 'watch' then 1 else 0 end) as sev,
      max(detected_at)::text as latest, max(image_date)::text as latest_img,
      bool_or(coalesce(image_date_end, image_date) >= ${opts.newSince.toISOString().slice(0, 10)}::date) as is_new,
      (array_agg(district_id order by detected_at desc))[1] as district_id,
      (array_agg(id order by detected_at desc))[1]::text as sample_id
    from change_events
    where ${and(...filters)}
    group by gx, gy, type, licensed
    order by sev desc, n desc
    limit 2000
  `);
  const list = toRows<GridRow>(result);
  const districtIds = [...new Set(list.map((r) => r.district_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (districtIds.length) {
    const ds = await db
      .select({ id: adminBoundaries.id, name: adminBoundaries.name })
      .from(adminBoundaries)
      .where(sql`${adminBoundaries.id} in ${districtIds}`);
    for (const d of ds) names.set(d.id, d.name);
  }
  const sevName: Severity[] = ["normal", "watch", "elevated", "urgent"];
  return list.map((r) => ({
    key: `${r.gx}:${r.gy}:${r.type}${r.licensed ? ":lic" : ""}`,
    licensed: Boolean(r.licensed),
    type: r.type as ChangeType,
    severity: sevName[Number(r.sev)] ?? "normal",
    count: Number(r.n),
    areaHa: r.area == null ? null : Number(r.area),
    isNew: Boolean(r.is_new),
    lon: Number(r.lon),
    lat: Number(r.lat),
    bbox: [Number(r.min_lon), Number(r.min_lat), Number(r.max_lon), Number(r.max_lat)],
    latestDetectedAt: new Date(r.latest).toISOString(),
    latestImageDate: r.latest_img,
    districtName: r.district_id ? names.get(r.district_id) ?? null : null,
    sampleId: r.sample_id,
  }));
}

export interface HomeStats {
  newLast72h: number;
  bySeverity: Record<Severity, number>;
  byType: Record<ChangeType, number>;
  districtsAffected30d: number;
  total30d: number;
}

export async function homeStats(now: Date = new Date()): Promise<HomeStats> {
  const db = await getDb();
  const since72 = new Date(now.getTime() - 72 * 3_600_000);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const sev = await db
    .select({ severity: changeEvents.severity, n: sql<number>`count(*)::int` })
    .from(changeEvents)
    .where(and(sql`coalesce(${changeEvents.imageDateEnd}, ${changeEvents.imageDate}) >= ${since72.toISOString().slice(0, 10)}::date`, sql`${changeEvents.status} <> 'dismissed'`, sql`${changeEvents.confidence} <> 'low'`))
    .groupBy(changeEvents.severity);
  const typ = await db
    .select({ type: changeEvents.type, n: sql<number>`count(*)::int` })
    .from(changeEvents)
    .where(and(sql`coalesce(${changeEvents.imageDateEnd}, ${changeEvents.imageDate}) >= ${since72.toISOString().slice(0, 10)}::date`, sql`${changeEvents.status} <> 'dismissed'`, sql`${changeEvents.confidence} <> 'low'`))
    .groupBy(changeEvents.type);
  const [m] = await db
    .select({
      total: sql<number>`count(*)::int`,
      districts: sql<number>`count(distinct ${changeEvents.districtId})::int`,
    })
    .from(changeEvents)
    .where(and(sql`coalesce(${changeEvents.imageDateEnd}, ${changeEvents.imageDate}) >= ${since30.toISOString().slice(0, 10)}::date`, sql`${changeEvents.status} <> 'dismissed'`, sql`${changeEvents.confidence} <> 'low'`));
  const bySeverity: Record<Severity, number> = { normal: 0, watch: 0, elevated: 0, urgent: 0 };
  for (const r of sev) bySeverity[r.severity as Severity] = Number(r.n);
  const byType: Record<ChangeType, number> = { vegetation_loss: 0, surface_disturbance: 0, water_change: 0, flood_risk: 0, fire: 0 };
  for (const r of typ) byType[r.type as ChangeType] = Number(r.n);
  return {
    newLast72h: Object.values(bySeverity).reduce((a, b) => a + b, 0),
    bySeverity,
    byType,
    districtsAffected30d: Number(m?.districts ?? 0),
    total30d: Number(m?.total ?? 0),
  };
}

/** Events near a point: bbox pre-filter then exact distance, nearest first. */
export async function nearEvents(center: { lon: number; lat: number }, radiusKm: number, limit: number, locale: Locale = "en") {
  const { bboxAround, haversineKm } = await import("@/lib/geo");
  const b = bboxAround(center, radiusKm);
  const since = new Date(Date.now() - 90 * 86_400_000);
  const page = await listEvents({ bbox: b, since, limit: 500, format: "json" } as EventsQuery, locale);
  return page.items
    .map((e) => ({ ...e, distanceKm: haversineKm(center, e.centroid) }))
    .filter((e) => e.distanceKm <= radiusKm)
    .sort((a, b2) => a.distanceKm - b2.distanceKm)
    .slice(0, limit);
}
