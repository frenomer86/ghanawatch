import { config as loadEnv } from "dotenv";
import { and, desc, eq, sql } from "drizzle-orm";
import { closeDb, getDb, migrateDb, rows, type Db } from "@/lib/db/client";
import { changeEvents, hotspotEvents, hotspots, imageReferences, pipelineRuns } from "@/lib/db/schema";
import { GHANA_BBOX, NEW_WINDOW_HOURS, type Severity } from "@/lib/domain/types";
import { bboxOf, centroidOf, validateGeometry } from "@/lib/geo";
import { stableId, uuidv7 } from "@/lib/server/ids";
import { sourceId } from "./seed/sources";
import { chunk } from "./seed/boundaries";
import type { Adapter, AdapterContext, NormalisedEvent } from "./adapters/types";
import { firmsAdapter } from "./adapters/firms";
import { firmsArchiveAdapter } from "./adapters/firms-archive";
import { NotConnectedError } from "./adapters/types";
import { glofasAdapter } from "./adapters/glofas";
import { sentinel2Adapter } from "./adapters/sentinel2";
import { sentinel1Adapter } from "./adapters/sentinel1";
import { timeseriesAdapter } from "./adapters/timeseries";
import { seedSources } from "./seed/sources";
import { forestLossAdapter } from "./adapters/forest-loss";
import { gfwAlertsAdapter } from "./adapters/gfw-alerts";
import { rainForecastAdapter } from "./adapters/rain-forecast";
import { newsSignalsAdapter } from "./adapters/news-signals";
import { maxSeverity } from "@/lib/domain/format";
import { ContextIndex, isSensitive } from "./context/annotate";
import { districtFor, loadDistricts, type DistrictShape } from "./districts";
import { tagWaterways } from "./context/waterways";
import { markLicensed } from "./context/licensed";

/**
 * `npm run pipeline [-- --only=nasa-firms] [-- --every=180]`
 *
 * --every=N keeps the process running and repeats the run every N minutes.
 *
 * For each adapter: read the last watermark, fetch new records, validate
 * geometry, assign districts, score severity, upsert on (source, sourceEventId),
 * then rebuild the 72-hour hotspot table. Each adapter runs in isolation so one
 * provider failing never blocks the others; every outcome is written to
 * pipeline_runs where the Data Sources page and /api/v1/freshness read it.
 */
const ADAPTERS: Adapter[] = [gfwAlertsAdapter, firmsAdapter, firmsArchiveAdapter, glofasAdapter, rainForecastAdapter, newsSignalsAdapter, sentinel2Adapter, timeseriesAdapter, sentinel1Adapter, forestLossAdapter];

async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const every = Number(process.argv.find((a) => a.startsWith("--every="))?.slice(8) ?? 0);
  await migrateDb();
  await runOnce();
  if (every > 0) {
    console.log(`[pipeline] next run in ${every} minutes (Ctrl+C to stop)`);
    setInterval(() => runOnce().catch((e) => console.error(e)), every * 60_000);
    await new Promise(() => undefined);
  }
}

async function runOnce() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const log = (s: string) => console.log(`[pipeline] ${s}`);
  const db = await getDb();
  const now = new Date();
  // Keep the source registry in step with the code, so a new source has its row before its first run.
  await seedSources(db, () => undefined);
  const districts = await loadDistricts(db);
  const context = await ContextIndex.load(db);

  for (const adapter of ADAPTERS) {
    if (only && adapter.slug !== only) continue;
    const sid = sourceId(adapter.slug);
    const runId = uuidv7();
    const [last] = await db
      .select({ watermark: pipelineRuns.watermark, finishedAt: pipelineRuns.finishedAt })
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.sourceId, sid), sql`${pipelineRuns.status} in ('ok', 'partial')`))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(1);
    if (!only && adapter.minIntervalHours && last?.finishedAt && now.getTime() - last.finishedAt.getTime() < adapter.minIntervalHours * 3_600_000) {
      log(`${adapter.slug}: up to date (last run ${last.finishedAt.toISOString()}), next after ${adapter.minIntervalHours} h`);
      continue;
    }
    await db.insert(pipelineRuns).values({ id: runId, sourceId: sid, status: "running", startedAt: now });

    const emitted = { inserted: 0, updated: 0, skipped: 0, fetched: 0 };
    const ctx: AdapterContext = {
      db,
      since: last?.watermark ?? undefined,
      now,
      log,
      fetchJson: (url, init) => fetchWithRetry(url, init).then((r) => r.json()),
      fetchText: (url, init) => fetchWithRetry(url, init).then((r) => r.text()),
      emit: async (evs) => {
        const s = await upsertEvents(db, evs, districts, runId, context);
        emitted.inserted += s.inserted;
        emitted.updated += s.updated;
        emitted.skipped += s.skipped;
        emitted.fetched += evs.length;
      },
      env: {},
    };

    try {
      const result = await adapter.run(ctx);
      const rest = await upsertEvents(db, result.events, districts, runId, context);
      const inserted = rest.inserted + emitted.inserted;
      const updated = rest.updated + emitted.updated;
      const skipped = rest.skipped + emitted.skipped;
      await db
        .update(pipelineRuns)
        .set({
          status: "ok",
          finishedAt: new Date(),
          watermark: result.watermark ?? last?.watermark ?? null,
          fetched: result.events.length + emitted.fetched,
          inserted,
          updated,
          skipped,
          error: result.notes?.length ? result.notes.join("; ").slice(0, 2000) : null,
          summary: result.extra ?? null,
        })
        .where(eq(pipelineRuns.id, runId));
      log(`${adapter.slug}: fetched ${result.events.length + emitted.fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}`);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        // Not a failure and not data: leave no run so the source reads "not connected".
        await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId));
        log(`${adapter.slug}: not connected (${err.message})`);
        continue;
      }
      const cause = err instanceof Error && err.cause ? ` (cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)})` : "";
      const message = (err instanceof Error ? err.message.slice(0, 300) : String(err)) + cause;
      await db.update(pipelineRuns).set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) }).where(eq(pipelineRuns.id, runId));
      log(`${adapter.slug}: FAILED ${message}`);
    }
  }

  const d = await contextCheck(db);
  if (d) log(`context check: ${d} detections moved to low confidence (town building or isolated clearing)`);
  const up = await contextUpgrade(db);
  if (up) log(`context upgrade: ${up} clearings beside mining pits shown as medium confidence`);
  const c = await corroborate(db);
  if (c) log(`corroboration: ${c} galamsey detections confirmed by a second, independent source`);
  const g = await forestAlertCheck(db);
  log(`forest alerts: ${g.shown} shown (a Sentinel-2 or radar detection nearby), ${g.possible} kept as possible`);
  const u = await urgentClusters(db);
  const lic = await markLicensed(db);
  log(`licensed mines: ${lic.marked} detections newly marked inside a mapped licensed mine, ${lic.cleared} unmarked`);
  log(`urgent clusters: ${u} pit sites in a dense cluster (10 ha or more of pits within about 1 km)`);
  const w = await tagWaterways(db);
  log(`waterways: ${w} clearings or pits inside rivers, drains or wetlands`);
  const n = await rebuildHotspots(db, now);
  log(`hotspots: ${n} clusters for the last ${NEW_WINDOW_HOURS} hours`);
}

async function fetchWithRetry(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      // Slow endpoints (Overpass) pass their own signal; everything else gets 30 s per attempt.
      const res = await fetch(url, { ...init, signal: init?.signal ?? ctrl.signal, headers: { "user-agent": "GhanaWatch/0.1 (+https://github.com/)", ...(init?.headers ?? {}) } });
      clearTimeout(t);
      if (res.status === 429) throw Object.assign(new Error("HTTP 429 (rate limited)"), { rateLimited: true });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true });
      return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) break;
      // Rate limits get a long back-off (15 s, 30 s); other errors a short one.
      const wait = (err as { rateLimited?: boolean }).rateLimited ? 15_000 * (i + 1) : 2 ** i * 1000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Context rules from the October 2026 accuracy check (40 detections against close-up imagery), where
 * the false alarms were new building in towns, lone clearings on farm plains and a seasonal flood:
 * - Sentinel-2 "cleared to bare ground" (no pits or ponds) inside a mapped residential area is
 *   building, not mining.
 * - Such a clearing with no shown pit or pond detection within about 1 km is a field, road or building plot;
 *   galamsey clearing comes with pits (second check, 17 Oct: 5 of 9 stand-alone clearings were wrong).
 * - A pond with no other shown pit or pond within about 1 km is a lake shore, beach or fish pond.
 * - A radar pond of 10 ha or more with no other shown detection within about 3 km is a flooded plain.
 * - Anything on the Accra plains or in the Volta delta (east of 0.45°W, south of 6.3°N). The rocks there hold
 *   no gold, so galamsey does not happen there; the national scan's detections there were salt pans and fish
 *   ponds around Songor and Keta lagoons, farms and new building.
 * - Anything in the Volta and Bui lake-shore districts (third check, 17 Oct: 4 of 5 misses were lake shore
 *   in Krachi East and Sene East). They lie in the Voltaian basin, which has no gold.
 * Each moves to low confidence (hidden by default, still downloadable) unless a high-confidence
 * Global Forest Watch alert overlaps it. Re-run after every pipeline run, since a rescan rewrites the detection.
 */
const COASTAL_PLAINS = sql`(e.centroid_lon > -0.45 and e.centroid_lat < 6.3)`;
/** Districts on the Volta and Bui lake shores, in the Voltaian basin, which holds no gold. */
const LAKE_DISTRICTS = sql`(e.district_id in (select id from admin_boundaries where level = 'district' and name in (
    'Krachi East Municipal', 'Krachi West', 'Krachi Nchumuru', 'Sene East', 'Sene West', 'Kwahu Afram Plains North',
    'Kwahu Afram Plains South', 'Pru East', 'Pru West', 'Biakoye', 'Atebubu Amantin', 'Banda')))`;
/** Another shown pit or pond detection (Sentinel-2 pits, radar ponds) within about 1 km. */
const PITS_NEAR = sql`exists (
    select 1 from change_events o
    where o.id <> e.id and o.status <> 'dismissed' and o.confidence in ('medium', 'high')
      and ((o.method_version like 's2-galamsey-%' and o.properties->>'signature' in ('new_pits', 'cleared_with_pits', 'mining')) or o.method_version like 's1-water-%')
      and o.centroid_lon between e.centroid_lon - 0.009 and e.centroid_lon + 0.009
      and o.centroid_lat between e.centroid_lat - 0.009 and e.centroid_lat + 0.009)`;

/**
 * The other side of the context rules, from the October 2026 detection-rate check (48 random squares in mining
 * districts, judged blind): half of the new mining the scan found was hidden because it showed as cleared
 * ground seen on fewer than three clear passes. Cleared ground right beside shown pits or ponds (within about
 * 1 km), outside towns, the north, the coast and the lake shore, is part of the same mining and is shown as
 * medium confidence. It never applies to a detection a context rule moved down.
 */
async function contextUpgrade(db: Db): Promise<number> {
  const res = await db.execute(sql`
    update change_events e set
      confidence = 'medium',
      confidence_score = greatest(coalesce(e.confidence_score, 0), 0.6),
      properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('contextUpgrade', 'cleared ground beside mining pits')
    where e.status <> 'dismissed' and e.confidence = 'low' and e.method_version like 's2-galamsey-%'
      and e.properties->>'signature' = 'cleared' and not (e.properties ? 'contextDowngrade')
      and coalesce(e.properties #>> '{placement,inResidential}', 'false') <> 'true'
      and e.centroid_lat < 8 and not ${COASTAL_PLAINS} and not ${LAKE_DISTRICTS}
      and ${PITS_NEAR}`);
  return (res as unknown as { count?: number }).count ?? (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
}

async function contextCheck(db: Db): Promise<number> {
  const res = await db.execute(sql`
    update change_events e set
      confidence = 'low',
      confidence_score = least(coalesce(e.confidence_score, 0.5), 0.4),
      properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('contextDowngrade',
        case
          when ${LAKE_DISTRICTS} then 'Volta or Bui lake shore, where the water level moves and there is no gold'
          when ${COASTAL_PLAINS} then 'Accra plains or Volta delta, where there is no gold: likely salt pans, fish ponds, farms or building'
          when e.method_version like 's1-water-%' then 'large lone pond, likely seasonal flooding'
          when e.properties #>> '{placement,inResidential}' = 'true' then 'inside a town: likely building'
          when e.properties->>'signature' = 'new_pits' then 'lone pond with no other mining nearby (lake shore, beach or fish pond)'
          else 'clearing with no mining pits nearby (farm, road or building site)'
        end)
    where e.status <> 'dismissed' and e.confidence in ('medium', 'high')
      and not (e.properties ? 'corroboratedBy')
      and (
        ((e.method_version like 's2-galamsey-%' or e.method_version like 's1-water-%') and (${COASTAL_PLAINS} or ${LAKE_DISTRICTS}))
        or (e.method_version like 's2-galamsey-%' and e.properties->>'signature' = 'cleared' and (
          e.properties #>> '{placement,inResidential}' = 'true' or not ${PITS_NEAR}))
        or (e.method_version like 's2-galamsey-%' and e.properties->>'signature' = 'new_pits' and not ${PITS_NEAR})
        or (e.method_version like 's1-water-%' and coalesce(e.area_ha, 0) >= 10 and not exists (
            select 1 from change_events o
            where o.id <> e.id and o.status <> 'dismissed' and o.confidence in ('medium', 'high') and (o.method_version like 's1-water-%' or o.method_version like 's2-galamsey-%')
              and o.centroid_lon between e.centroid_lon - 0.027 and e.centroid_lon + 0.027
              and o.centroid_lat between e.centroid_lat - 0.027 and e.centroid_lat + 0.027))
      )
      and not exists (
        select 1 from change_events a
        where a.method_version like 'gfw-integrated-%' and (a.confidence = 'high' or a.properties->>'gfwConfidence' = 'high') and a.status <> 'dismissed'
          and a.bbox_max_lon >= e.bbox_min_lon - 0.0015 and a.bbox_min_lon <= e.bbox_max_lon + 0.0015
          and a.bbox_max_lat >= e.bbox_min_lat - 0.0015 and a.bbox_min_lat <= e.bbox_max_lat + 0.0015)`);
  return (res as unknown as { count?: number }).count ?? (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
}

/**
 * Global Forest Watch alerts are shown by default only where our own Sentinel-2 or radar scan also sees
 * activity within about 1 km. In the October 2026 check, only 9 to 12 of 20 stand-alone high-confidence
 * alerts of 1 ha or more showed a clearing that free 10 m imagery can confirm, and alerts under 1 ha
 * (most of them) are below what that imagery resolves. The others stay as "possible" detections: on the
 * map behind the possible-detections switch and in downloads, never deleted. The alert's own confidence is
 * kept in gfwConfidence so it still corroborates our detections. Runs after every pipeline run.
 */
async function forestAlertCheck(db: Db): Promise<{ shown: number; possible: number }> {
  const near = sql`exists (
      select 1 from change_events o
      where o.status <> 'dismissed' and o.confidence in ('medium', 'high')
        and (o.method_version like 's2-galamsey-%' or o.method_version like 's1-water-%')
        and o.centroid_lon between e.centroid_lon - 0.009 and e.centroid_lon + 0.009
        and o.centroid_lat between e.centroid_lat - 0.009 and e.centroid_lat + 0.009)`;
  await db.execute(sql`
    update change_events e set
      confidence = 'low',
      properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('gfwConfidence', 'high',
        'contextDowngrade', 'forest-loss alert not yet confirmed by our own Sentinel-2 or radar scan')
    where e.method_version like 'gfw-integrated-%' and e.status <> 'dismissed' and e.confidence = 'high' and not ${near}`);
  await db.execute(sql`
    update change_events e set
      confidence = 'high',
      properties = (coalesce(e.properties, '{}'::jsonb) - 'contextDowngrade') || jsonb_build_object('confirmedBy', 'own scan within 1 km')
    where e.method_version like 'gfw-integrated-%' and e.status <> 'dismissed' and e.confidence = 'low'
      and e.properties->>'gfwConfidence' = 'high' and ${near}`);
  const [{ shown, possible }] = rows<{ shown: number; possible: number }>(await db.execute(sql`
    select count(*) filter (where confidence = 'high')::int shown, count(*) filter (where confidence = 'low')::int possible
    from change_events where method_version like 'gfw-integrated-%' and status <> 'dismissed'`));
  return { shown, possible };
}

/**
 * Galamsey shows up as many pits of 0.5 to 5 ha side by side, so a single outline rarely reaches the 15 ha
 * Urgent threshold. A shown pit or pond detection (Sentinel-2 pits, radar ponds; not mapped mines) whose
 * shown pit and pond neighbours within about 1 km add up to 10 ha or more is raised to Urgent. The level it
 * had is kept in severityBefore, so it drops back when the cluster no longer qualifies. Runs after every
 * pipeline run, after the confidence rules.
 */
const URGENT_CLUSTER_HA = 10;

async function urgentClusters(db: Db): Promise<number> {
  const pit = (t: string) =>
    sql.raw(`${t}.status <> 'dismissed' and ${t}.confidence in ('medium', 'high') and ${t}.properties #>> '{placement,mine}' is null and not (${t}.properties ? 'licensedMine')
      and ((${t}.method_version like 's2-galamsey-%' and ${t}.properties->>'signature' in ('new_pits', 'cleared_with_pits', 'mining')) or ${t}.method_version like 's1-water-%')`);
  const clusterHa = sql`(select coalesce(sum(o.area_ha), 0) from change_events o
      where ${pit("o")}
        and o.centroid_lon between e.centroid_lon - 0.009 and e.centroid_lon + 0.009
        and o.centroid_lat between e.centroid_lat - 0.009 and e.centroid_lat + 0.009)`;
  // Drop back the ones that no longer qualify (neighbours hidden or rescanned).
  await db.execute(sql`
    update change_events e set severity = e.properties->>'severityBefore', properties = e.properties - 'severityBefore' - 'urgentClusterHa'
    where e.properties ? 'severityBefore' and not (${pit("e")} and ${clusterHa} >= ${URGENT_CLUSTER_HA})`);
  await db.execute(sql`
    update change_events e set
      properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('severityBefore', e.severity, 'urgentClusterHa', round(${clusterHa}::numeric, 1)),
      severity = 'urgent'
    where ${pit("e")} and e.severity <> 'urgent' and ${clusterHa} >= ${URGENT_CLUSTER_HA}`);
  const [{ n }] = rows<{ n: number }>(await db.execute(sql`select count(*)::int n from change_events where properties ? 'urgentClusterHa'`));
  return n;
}

/**
 * Two independent sources agreeing is the strongest evidence a free-data system can give. A Sentinel-2
 * galamsey detection (medium confidence) or a radar pond that overlaps, within about 150 m, a
 * high-confidence Global Forest Watch alert (GLAD/RADD) becomes high confidence. Low-confidence
 * detections (the savannah north) are not raised, because farm clearing also shows as tree loss there.
 * Re-run after every pipeline run, since a rescan rewrites the detection.
 */
async function corroborate(db: Db): Promise<number> {
  const res = await db.execute(sql`
    update change_events e set
      confidence = 'high',
      confidence_score = greatest(coalesce(e.confidence_score, 0), 0.85),
      properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('corroboratedBy', 'gfw-integrated-alerts')
    where e.status <> 'dismissed' and e.confidence = 'medium'
      and ((e.method_version like 's2-galamsey-%' and e.type = 'surface_disturbance') or e.method_version like 's1-water-%')
      and exists (
        select 1 from change_events a
        where a.method_version like 'gfw-integrated-%' and (a.confidence = 'high' or a.properties->>'gfwConfidence' = 'high') and a.status <> 'dismissed'
          and a.bbox_max_lon >= e.bbox_min_lon - 0.0015 and a.bbox_min_lon <= e.bbox_max_lon + 0.0015
          and a.bbox_max_lat >= e.bbox_min_lat - 0.0015 and a.bbox_min_lat <= e.bbox_max_lat + 0.0015)`);
  return (res as unknown as { count?: number; affectedRows?: number }).count ?? (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
}

/** Risk level from type, area and confidence; adapters may override. Published on /data/methods. */
export function scoreSeverity(ev: NormalisedEvent): Severity {
  if (ev.severity) return ev.severity;
  const area = ev.areaHa ?? 0;
  const highConf = ev.confidence === "high";
  switch (ev.type) {
    case "vegetation_loss":
      return area >= 25 && highConf ? "urgent" : area >= 25 ? "elevated" : area >= 5 ? "watch" : "normal";
    case "surface_disturbance":
      return area >= 15 && highConf ? "urgent" : area >= 15 ? "elevated" : area >= 3 ? "watch" : "normal";
    case "water_change":
      return highConf ? "watch" : "normal";
    case "flood_risk":
      return "watch";
    case "fire":
      return "normal";
  }
}

const SEVERITY_STEPS: Severity[] = ["normal", "watch", "elevated", "urgent"];
const LAND_TYPES = new Set(["surface_disturbance", "vegetation_loss", "water_change"]);

async function upsertEvents(db: Db, events: NormalisedEvent[], districts: DistrictShape[], runId: string, context: ContextIndex) {
  let inserted = 0,
    updated = 0,
    skipped = 0;
  const rows = [];
  const images: Array<{ eventId: string; img: NonNullable<NormalisedEvent["images"]>[number] }> = [];
  const [gMinLon, gMinLat, gMaxLon, gMaxLat] = GHANA_BBOX;
  // One row per (source, sourceEventId) per batch; keep the larger detection when two round to the same id.
  const byId = new Map<string, NormalisedEvent>();
  for (const ev of events) {
    const k = `${ev.sourceSlug}:${ev.sourceEventId}`;
    const prev = byId.get(k);
    if (!prev || (ev.areaHa ?? 0) > (prev.areaHa ?? 0)) byId.set(k, ev);
  }
  const uniqueEvents = [...byId.values()];
  skipped += events.length - uniqueEvents.length;
  for (const ev of uniqueEvents) {
    const valid = validateGeometry(ev.geom, { maxVertices: 10_000, within: [gMinLon - 1, gMinLat - 1, gMaxLon + 1, gMaxLat + 1] });
    if (!valid.ok) {
      skipped++;
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.imageDate) || new Date(`${ev.imageDate}T00:00:00Z`) > ev.detectedAt) {
      skipped++;
      continue;
    }
    const b = bboxOf(ev.geom);
    const c = centroidOf(ev.geom);
    const d = districtFor(c.lon, c.lat, districts);
    if (!d) {
      // Inside the bounding box but outside Ghana (Togo, Côte d’Ivoire, Burkina Faso, sea).
      skipped++;
      continue;
    }
    const id = stableId("event", `${ev.sourceSlug}:${ev.sourceEventId}`);
    const placement = context.place(c.lon, c.lat);
    rows.push({
      id,
      sourceId: sourceId(ev.sourceSlug),
      sourceEventId: ev.sourceEventId,
      runId,
      type: ev.type,
      detectedAt: ev.detectedAt,
      imageDate: ev.imageDate,
      imageDateEnd: ev.imageDateEnd ?? null,
      firstImageDate: ev.firstImageDate && /^\d{4}-\d{2}-\d{2}$/.test(ev.firstImageDate) && ev.firstImageDate <= ev.imageDate ? ev.firstImageDate : ev.imageDate,
      confidence: ev.confidence,
      confidenceScore: ev.confidenceScore ?? null,
      severity: (() => {
        const base = scoreSeverity(ev);
        // Disturbance in a residential area, near a school, cemetery or clinic, or in a protected area is more serious;
        // inside a named large-scale mine it is the mine's own work, so it is not raised.
        if (!LAND_TYPES.has(ev.type) || placement.mine || !isSensitive(placement)) return base;
        return SEVERITY_STEPS[Math.min(3, SEVERITY_STEPS.indexOf(base) + 1)];
      })(),
      areaHa: ev.areaHa ?? null,
      districtId: d?.id ?? null,
      geom: ev.geom,
      bboxMinLon: b[0],
      bboxMinLat: b[1],
      bboxMaxLon: b[2],
      bboxMaxLat: b[3],
      centroidLon: c.lon,
      centroidLat: c.lat,
      titleEn: (() => {
        // Say where a land disturbance is when it matters: in a reserve, a mapped mine, a residential area, near a school or on farmland.
        const parts = [ev.titleEn];
        if (LAND_TYPES.has(ev.type)) {
          const school = placement.nearby.find((x) => x.kind === "school" && x.distanceM <= 300);
          if (placement.protectedArea) parts.push(`inside ${placement.protectedArea}`);
          else if (placement.mine) parts.push(`inside ${placement.mine}`);
          else if (placement.inResidential) parts.push("inside a residential area");
          else if (school) parts.push(`${school.distanceM} m from ${school.name ?? "a school"}`);
          else if (placement.onFarmland) parts.push("on farmland");
        }
        return `${parts.join(", ")}, ${d.name}`;
      })(),
      titleTw: ev.titleTw ?? null,
      descriptionEn: ev.descriptionEn,
      descriptionTw: ev.descriptionTw ?? null,
      methodVersion: ev.methodVersion,
      properties: { ...(ev.properties ?? {}), placement },
    });
    for (const img of ev.images ?? []) images.push({ eventId: id, img });
  }

  for (const batch of chunk(rows, 100)) {
    const result = await db
      .insert(changeEvents)
      .values(batch)
      .onConflictDoUpdate({
        target: [changeEvents.sourceId, changeEvents.sourceEventId],
        set: {
          // A detection hidden by an automatic check (superseded method, seasonal water) comes back when a
          // newer scan finds it again; one a moderator dismissed stays dismissed.
          status: sql`case when ${changeEvents.properties} ? 'autoDismissed' then 'new' else ${changeEvents.status} end`,
          detectedAt: sql`excluded.detected_at`,
          imageDate: sql`excluded.image_date`,
          imageDateEnd: sql`excluded.image_date_end`,
          // The first date the site was seen never moves forward: a rescan only ever confirms it again.
          firstImageDate: sql`least(coalesce(${changeEvents.firstImageDate}, excluded.first_image_date), excluded.first_image_date)`,
          confidence: sql`excluded.confidence`,
          confidenceScore: sql`excluded.confidence_score`,
          severity: sql`excluded.severity`,
          areaHa: sql`excluded.area_ha`,
          geom: sql`excluded.geom`,
          bboxMinLon: sql`excluded.bbox_min_lon`,
          bboxMinLat: sql`excluded.bbox_min_lat`,
          bboxMaxLon: sql`excluded.bbox_max_lon`,
          bboxMaxLat: sql`excluded.bbox_max_lat`,
          centroidLon: sql`excluded.centroid_lon`,
          centroidLat: sql`excluded.centroid_lat`,
          properties: sql`excluded.properties`,
          runId: sql`excluded.run_id`,
          titleEn: sql`excluded.title_en`,
          titleTw: sql`excluded.title_tw`,
          descriptionEn: sql`excluded.description_en`,
          descriptionTw: sql`excluded.description_tw`,
          districtId: sql`excluded.district_id`,
          methodVersion: sql`excluded.method_version`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    for (const r of result as Array<{ createdAt: Date; updatedAt: Date }>) {
      if (Math.abs(r.createdAt.getTime() - r.updatedAt.getTime()) < 1000) inserted++;
      else updated++;
    }
  }

  const ids = [...new Set(images.map((i) => i.eventId))];
  for (const batch of chunk(ids, 200)) await db.delete(imageReferences).where(sql`${imageReferences.changeEventId} in ${batch}`);
  const imageRows = images.map(({ eventId, img }) => ({
    id: uuidv7(),
    changeEventId: eventId,
    role: img.role,
    sourceId: sourceId(img.sourceSlug),
    productId: img.productId ?? null,
    sensor: img.sensor ?? null,
    acquiredAt: img.acquiredAt,
    cloudCoverPct: img.cloudCoverPct ?? null,
    thumbnailUrl: img.thumbnailUrl ?? null,
    tileUrlTemplate: img.tileUrlTemplate ?? null,
    licence: img.licence ?? null,
  }));
  for (const batch of chunk(imageRows, 200)) await db.insert(imageReferences).values(batch);

  return { inserted, updated, skipped };
}

/** Rebuild the SRS "Hotspot" entity for the last 72 hours on a 0.1° grid per type. */
async function rebuildHotspots(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - NEW_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      severity: changeEvents.severity,
      areaHa: changeEvents.areaHa,
      lon: changeEvents.centroidLon,
      lat: changeEvents.centroidLat,
      districtId: changeEvents.districtId,
      titleEn: changeEvents.titleEn,
    })
    .from(changeEvents)
    .where(and(sql`coalesce(${changeEvents.imageDateEnd}, ${changeEvents.imageDate}) >= ${since.toISOString().slice(0, 10)}::date`, sql`${changeEvents.status} <> 'dismissed'`, sql`${changeEvents.confidence} <> 'low'`));
  const cell = 0.1;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.lon == null || r.lat == null) continue;
    const key = `${Math.floor(r.lon / cell)}:${Math.floor(r.lat / cell)}:${r.type}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  await db.delete(hotspots);
  let n = 0;
  for (const [, members] of groups) {
    const lon = members.reduce((s, m) => s + (m.lon ?? 0), 0) / members.length;
    const lat = members.reduce((s, m) => s + (m.lat ?? 0), 0) / members.length;
    const id = uuidv7();
    const sev = maxSeverity(members.map((m) => m.severity as Severity));
    const districtId = members.find((m) => m.districtId)?.districtId ?? null;
    await db.insert(hotspots).values({
      id,
      windowStart: since,
      windowEnd: now,
      type: members[0].type,
      severity: sev,
      eventCount: members.length,
      areaHaTotal: members.reduce((s, m) => s + (m.areaHa ?? 0), 0),
      districtId,
      isNew: true,
      labelEn: members.length === 1 ? members[0].titleEn : `${members.length} ${members[0].type.replace("_", " ")} detections`,
      centroidLon: lon,
      centroidLat: lat,
      bboxMinLon: Math.min(...members.map((m) => m.lon ?? lon)),
      bboxMinLat: Math.min(...members.map((m) => m.lat ?? lat)),
      bboxMaxLon: Math.max(...members.map((m) => m.lon ?? lon)),
      bboxMaxLat: Math.max(...members.map((m) => m.lat ?? lat)),
    });
    await db.insert(hotspotEvents).values(members.map((m) => ({ hotspotId: id, changeEventId: m.id })));
    n++;
  }
  return n;
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
