import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import { analysisCells, historyEvents, historyProgress } from "@/lib/db/schema";
import { areaHectares, bboxOf, centroidOf } from "@/lib/geo";
import { stableId } from "@/lib/server/ids";
import { monthOf, previousMonth } from "@/lib/domain/index";
import { NotConnectedError, type Adapter, type NormalisedEvent } from "./types";
import { detector } from "../ts/mode";
import { stateLastMonth, UNDER_MINING_SHARE } from "../ts/handover";
import { cellLayout, DATA_DIR, processCellMonth, STATE_RES, type CellMonthResult, type CellRow } from "../ts/cell";
import { loadModel, type MiningModel } from "../ts/model";
import { siteHull, type TsSite } from "../ts/sites";
import { monthIndex, monthName } from "../ts/tracker";
import { defineEpsg } from "../ts/cog";
import proj4 from "proj4";
import { ContextIndex } from "../context/annotate";
import { DistrictIndex, loadDistricts } from "../districts";
import { searchS2 } from "../ts/catalog";
import type { Db } from "@/lib/db/client";

/**
 * GhanaWatch multi-sensor galamsey detector (method s2-galamsey-3.0).
 *
 * Every month, for every scan cell: a composite from all Sentinel-2 bands, Landsat 8/9 where Sentinel-2
 * was clouded out, Sentinel-1 radar and elevation; a U-Net trained on hand-mapped Ghanaian mines gives
 * each pixel a probability of being mined; a per-pixel tracker turns the monthly probabilities into a
 * dated history (when mining started, whether the site is still spreading or has regrown). See
 * src/pipeline/ts/* and docs/detector.md.
 *
 * Two outputs:
 *  - change_events: one detection per site as it stands now, with its onset month, its mined area by
 *    month, and before/latest Sentinel-2 images; the map, district pages and alerts read these.
 *  - history_events: for each finished month, the area each site added that month (newly confirmed),
 *    which is what the Galamsey Index counts. These rows never change once written.
 *
 * Months are processed in order and only after they end. The month in progress is previewed (provisional
 * detections, nothing saved to the tracker) once ten days of it have passed, so alerts are not a month late.
 */
export const SLUG = "gw-multisensor";
export const METHOD = "s2-galamsey-3.0";
/** The tracker starts in 2017 so that mining which predates the index series (2019) is known as such. */
export const TRACKER_START = process.env.GW_TS_START ?? "2017-01";
export const SERIES_START = "2019-01";

const licence = "Copernicus Sentinel data and USGS Landsat data, free and open";

export const timeseriesAdapter: Adapter = {
  slug: SLUG,
  async run(ctx) {
    if (!ctx.db) throw new Error("database handle required");
    if (detector() === "legacy") throw new NotConnectedError(process.env.GW_DETECTOR !== "multisensor" ? "not enabled on this machine (GW_DETECTOR=multisensor): the two-date Sentinel-2 scan is the live detector" : "model files missing (models/gw_mining_unet.onnx, .json): the two-date Sentinel-2 scan stays the live detector");
    const db = ctx.db;
    const model = await loadModel();
    const budgetMs = Number(process.env.GW_TS_BUDGET_MINUTES ?? 60) * 60_000;
    const started = Date.now();
    const lastComplete = previousMonth(monthOf(ctx.now));
    const districts = new DistrictIndex(await loadDistricts(db));
    const context = await ContextIndex.load(db);
    const only = process.env.GW_TS_CELLS ? new Set(process.env.GW_TS_CELLS.split(",").map((x) => x.trim())) : null;
    const queue = dueTrackerCells((await db.select().from(analysisCells)).filter((c) => !only || only.has(c.id)), ctx.now);
    const notes: string[] = [];
    let cells = 0;
    let events = 0;
    for (const c of queue) {
      if (Date.now() - started > budgetMs) break;
      try {
        const res = await catchUp(c, lastComplete, model, ctx.fetchJson, ctx.log, async (r) => {
          await writeHistory(db, r, districts, context);
        }, started + budgetMs);
        if (!res) continue;
        if (res.month !== lastComplete) {
          // Still catching up on its history: map detections wait until the cell reaches the present.
          ctx.log(`${SLUG}: cell ${c.id} caught up to ${res.month} of ${lastComplete}; detections are published once it is current`);
          continue;
        }
        // Preview the month in progress once ten days of it have passed (at most every five days per cell).
        let shown = res;
        if (ctx.now.getUTCDate() >= 10 && process.env.GW_TS_PREVIEW !== "0" && res.month === lastComplete && previewDue(c.id, ctx.now)) {
          shown = await processCellMonth(c, monthOf(ctx.now), model, ctx.fetchJson, ctx.log, { save: false });
          markPreview(c.id, ctx.now);
        }
        const evs = await toEvents(shown, ctx.now, ctx.fetchJson, shown.month !== res.month);
        if (ctx.emit) await ctx.emit(evs);
        await dismissGone(db, c.id, evs.map((e) => e.sourceEventId), ctx.now);
        await supersedeLegacy(db, c);
        cells++;
        events += evs.length;
        ctx.log(`${SLUG}: cell ${c.id} (${c.regionName ?? "Ghana"}) up to ${shown.month}${shown.month !== res.month ? " (provisional)" : ""}: ${evs.length} sites, cover S2 ${Math.round(shown.coverage.sentinel2 * 100)}% Landsat ${Math.round(shown.coverage.landsat * 100)}% radar-only ${Math.round(shown.coverage.radar * 100)}%`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notes.push(`${c.id}: ${msg.slice(0, 200)}`);
        ctx.log(`${SLUG}: cell ${c.id} failed: ${msg.slice(0, 300)}`);
      }
    }
    if (!cells && queue.length) throw new Error(`No cell could be processed. ${notes.slice(0, 3).join("; ")}`);
    return { events: [], watermark: ctx.now, notes: notes.slice(0, 20), extra: { cells, sites: events, cellsWaiting: Math.max(0, queue.length - cells), model: `${model.meta.model} ${model.meta.version}` } };
  },
};

/**
 * Cells in the order the tracker should visit them: furthest behind first, the mining belt before the rest,
 * then cells whose month-in-progress preview is oldest.
 */
export function dueTrackerCells<T extends CellRow>(cells: T[], now: Date): T[] {
  const behind = (c: T) => stateLastMonth(c.id);
  const lastPreview = (c: T) => {
    const p = join(DATA_DIR, "preview", `${c.id}.json`);
    return existsSync(p) ? Number(JSON.parse(readFileSync(p, "utf8")).at ?? 0) : 0;
  };
  void now;
  return cells
    .map((c) => ({ c, m: behind(c), p: lastPreview(c) }))
    .sort((a, b) => a.m - b.m || b.c.priority - a.c.priority || a.p - b.p || a.c.id.localeCompare(b.c.id))
    .map((x) => x.c);
}

function previewDue(cellId: string, now: Date): boolean {
  const p = join(DATA_DIR, "preview", `${cellId}.json`);
  if (!existsSync(p)) return true;
  return now.getTime() - Number(JSON.parse(readFileSync(p, "utf8")).at ?? 0) >= 5 * 86_400_000;
}

function markPreview(cellId: string, now: Date) {
  mkdirSync(join(DATA_DIR, "preview"), { recursive: true });
  writeFileSync(join(DATA_DIR, "preview", `${cellId}.json`), JSON.stringify({ at: now.getTime() }));
}

/**
 * Once a cell is current, the 2.x land galamsey there (pits, cleared ground with pits, radar ponds) is hidden
 * as superseded by the tracker's sites (not deleted; anything a moderator reviewed stays). Muddy rivers stay,
 * and so does 2.x cleared land (the cleared-land lines of the district and reserve cards), except where it lies
 * within one of the tracker's mining sites, which already counts it; that is hidden as an automatic check, so
 * it comes back if a later scan finds it outside a site.
 */
export async function supersedeLegacy(db: Db, c: CellRow) {
  await db.execute(sql`update change_events set status = 'dismissed',
      properties = coalesce(properties, '{}'::jsonb) || jsonb_build_object('supersededBy', ${METHOD}::text)
    where status = 'new' and (
      (method_version like 's2-galamsey-2.%' and type = 'surface_disturbance' and properties->>'cell' = ${c.id}::text
        and coalesce(properties->>'signature', '') <> 'cleared')
      or (method_version like 's1-water-%' and centroid_lon >= ${c.minLon} and centroid_lon < ${c.maxLon} and centroid_lat >= ${c.minLat} and centroid_lat < ${c.maxLat}))`);
  await db.execute(sql`update change_events e set status = 'dismissed',
      properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('autoDismissed', 'part of a mining site mapped by the monthly multi-sensor record')
    where e.status = 'new' and e.method_version like 's2-galamsey-2.%' and e.properties->>'signature' = 'cleared' and e.properties->>'cell' = ${c.id}::text
      and exists (select 1 from change_events m
        where m.method_version = ${METHOD} and m.status <> 'dismissed' and m.properties->>'cell' = ${c.id}::text
          and greatest(0, least(e.bbox_max_lon, m.bbox_max_lon) - greatest(e.bbox_min_lon, m.bbox_min_lon))
            * greatest(0, least(e.bbox_max_lat, m.bbox_max_lat) - greatest(e.bbox_min_lat, m.bbox_min_lat))
            >= ${UNDER_MINING_SHARE} * (e.bbox_max_lon - e.bbox_min_lon) * (e.bbox_max_lat - e.bbox_min_lat))`);
}

/**
 * Bring a cell's tracker up to `upTo` (a finished month), one month at a time from where it stopped (or
 * from TRACKER_START). `onMonth` receives every finished month. Returns the last result, or null when
 * the time budget ran out before any month was done.
 */
export async function catchUp(
  c: CellRow,
  upTo: string,
  model: MiningModel,
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>,
  log: (m: string) => void,
  onMonth: (r: CellMonthResult) => Promise<void>,
  deadline = Number.POSITIVE_INFINITY,
): Promise<CellMonthResult | null> {
  let last: CellMonthResult | null = null;
  let m = TRACKER_START;
  // Skip to the month after the last one processed.
  const { loadState } = await import("../ts/cell");
  const L = cellLayout(c);
  const s = loadState(c.id, L.state.width * L.state.height);
  if (s.lastMonth >= 0) m = monthName(s.lastMonth + 1);
  while (monthIndex(m) <= monthIndex(upTo)) {
    if (Date.now() > deadline) break;
    last = await processCellMonth(c, m, model, fetchJson, log);
    await onMonth(last);
    m = monthName(monthIndex(m) + 1);
  }
  if (!last && s.lastMonth >= 0) last = await processCellMonth(c, monthName(s.lastMonth), model, fetchJson, log); // already up to date: re-read its sites
  return last;
}

function lonLat(r: CellMonthResult, px: number): [number, number] {
  const S = r.layout.state;
  const x = px % S.width;
  const y = (px - x) / S.width;
  return proj4(defineEpsg(S.epsg), "EPSG:4326", [S.bbox[0] + (x + 0.5) * STATE_RES, S.bbox[3] - (y + 0.5) * STATE_RES]) as [number, number];
}

export function siteId(r: CellMonthResult, s: TsSite): string {
  const [lon, lat] = lonLat(r, s.anchor);
  return `ts-${lon.toFixed(4)}-${lat.toFixed(4)}`;
}

function sitePolygon(r: CellMonthResult, s: TsSite): Polygon {
  const S = r.layout.state;
  const to = defineEpsg(S.epsg);
  const ring = siteHull(s.pixels, S.width, S.bbox, STATE_RES).map((p) => proj4(to, "EPSG:4326", p) as [number, number]);
  return { type: "Polygon", coordinates: [ring] };
}

const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export function confidenceOf(s: TsSite, lat: number): NormalisedEvent["confidence"] {
  const north = lat > 8.0;
  if (north) return s.meanP >= 0.9 && s.meanObserved >= 6 ? "medium" : "low";
  if (s.meanP >= 0.8 && s.meanObserved >= 6) return "high";
  if (s.meanP >= 0.6) return "medium";
  return "low";
}

/** One detection per site as it stands in the month of `r`. */
export async function toEvents(r: CellMonthResult, now: Date, fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>, provisional = false): Promise<NormalisedEvent[]> {
  const out: NormalisedEvent[] = [];
  for (const s of r.sites) {
    const geom = sitePolygon(r, s);
    const centre = centroidOf(geom);
    const sourceEventId = siteId(r, s);
    const id = stableId("event", `${SLUG}:${sourceEventId}`);
    const confidence = confidenceOf(s, centre.lat);
    const north = centre.lat > 8.0;
    const ha = s.areaHa;
    const haText = ha >= 10 ? Math.round(ha).toString() : ha.toFixed(1);
    const expanding = s.expandingHa >= 0.2;
    const severity: NormalisedEvent["severity"] = confidence === "low" ? "watch" : ha >= 15 ? (confidence === "high" ? "urgent" : "elevated") : ha >= 2 ? "elevated" : "watch";
    const onsetText = s.onset <= TRACKER_START ? `before ${TRACKER_START.slice(0, 4)}` : new Date(`${s.onset}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const images = await evidence(r, s, geom, fetchJson).catch(() => []);
    out.push({
      sourceSlug: SLUG,
      sourceEventId,
      type: "surface_disturbance",
      detectedAt: now,
      imageDate: lastDay(r.month) > now.toISOString().slice(0, 10) ? now.toISOString().slice(0, 10) : lastDay(r.month),
      firstImageDate: s.onset <= TRACKER_START ? `${TRACKER_START}-01` : `${s.onset}-01`,
      confidence,
      confidenceScore: Math.round(s.meanP * 100) / 100,
      severity,
      areaHa: ha,
      geom,
      titleEn: `${expanding ? "Spreading" : "Likely"} galamsey site, about ${haText} ha`,
      titleTw: `Ɛte sɛ galamsey beaeɛ, bɛyɛ ${haText} ha`,
      descriptionEn:
        `GhanaWatch's monthly satellite record shows a mining footprint of about ${ha} ha here, first seen in ${onsetText}.` +
        (expanding ? ` About ${s.expandingHa} ha of it is new in the last three months.` : "") +
        ` The record combines every Sentinel-2 image of each month, Landsat where cloud hid Sentinel-2, and Sentinel-1 radar through cloud; a model trained on hand-mapped Ghanaian mines scores each month and the site counts only once the evidence has built up over months.` +
        (north ? " In the savannah north, flooded fields and newly ploughed land can look similar, so this is marked low confidence unless the signal is very strong." : "") +
        (provisional ? " This month is not over yet, so the newest part is provisional." : "") +
        " This is a detected change, not a legal finding; ground verification is encouraged.",
      descriptionTw: "Satellite kyerɛ sɛ wɔatutu asase wɔ ha te sɛ galamsey. Ɛhia sɛ wɔkɔhwɛ.",
      methodVersion: METHOD,
      properties: {
        signature: "mining",
        cell: r.cell.id,
        resolutionM: r.layout.res,
        trackerResolutionM: STATE_RES,
        onsetMonth: s.onset,
        onsetHa: s.onsetHa,
        expandingHa: s.expandingHa,
        meanProbability: Math.round(s.meanP * 1000) / 1000,
        monthsObserved: Math.round(s.meanObserved),
        hullAreaHa: Math.round(areaHectares(geom) * 100) / 100,
        coverage: r.coverage,
        scenes: { sentinel2: r.scenes.s2.length, landsat: r.scenes.landsat.length, sentinel1: r.scenes.s1.length },
        provisional,
        model: "gw_mining_unet",
      },
      images,
    });
  }
  return out;
}

/** Before (the clearest Sentinel-2 image in the half year before onset) and latest (this month) images. */
async function evidence(r: CellMonthResult, s: TsSite, geom: Polygon, fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>): Promise<NonNullable<NormalisedEvent["images"]>> {
  const b = bboxOf(geom);
  const id = stableId("event", `${SLUG}:${siteId(r, s)}`);
  const pickClearest = async (from: string, to: string) => {
    const [fy, fm] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    const scenes = await searchS2(fetchJson, [b[0], b[1], b[2], b[3]], new Date(Date.UTC(fy, fm - 1, 1)), new Date(Date.UTC(ty, tm, 1)), 30);
    return scenes.filter((x) => x.visual).sort((a, c) => a.cloud - c.cloud)[0] ?? null;
  };
  const out: NonNullable<NormalisedEvent["images"]> = [];
  const onsetIdx = monthIndex(s.onset);
  const before = s.onset > TRACKER_START ? await pickClearest(monthName(Math.max(0, onsetIdx - 6)), monthName(onsetIdx - 1)) : null;
  const latest = await pickClearest(monthName(monthIndex(r.month) - 2), r.month);
  for (const [role, sc] of [["latest", latest], ["before", before]] as const) {
    if (!sc) continue;
    out.push({ role, sourceSlug: SLUG, productId: sc.id, sensor: "Sentinel-2 MSI", acquiredAt: new Date(sc.datetime), cloudCoverPct: Math.round(sc.cloud * 10) / 10, thumbnailUrl: `/api/v1/events/${id}/image?role=${role}`, tileUrlTemplate: sc.visual, licence });
  }
  return out;
}

/** History rows: for a finished month, the area each site added that month. Written once, never changed. */
export async function writeHistory(db: Db, r: CellMonthResult, districts: DistrictIndex, context: ContextIndex) {
  const rows: Array<typeof historyEvents.$inferInsert> = [];
  for (const s of r.sites) {
    if (s.newlyConfirmedHa <= 0) continue;
    const geom = sitePolygon(r, s);
    const c = centroidOf(geom);
    const d = districts.find(c.lon, c.lat);
    if (!d) continue;
    const b = bboxOf(geom);
    const sid = siteId(r, s);
    rows.push({
      id: stableId("history", `${r.month}:${sid}`),
      scanMonth: r.month,
      sourceEventId: sid,
      type: "surface_disturbance",
      imageDate: lastDay(r.month),
      confidence: confidenceOf(s, c.lat),
      severity: "normal",
      areaHa: s.newlyConfirmedHa,
      districtId: d.id,
      geom,
      bboxMinLon: b[0],
      bboxMinLat: b[1],
      bboxMaxLon: b[2],
      bboxMaxLat: b[3],
      centroidLon: c.lon,
      centroidLat: c.lat,
      methodVersion: METHOD,
      properties: { signature: "mining", cohort: true, siteKey: sid, siteAreaHa: s.areaHa, onsetHa: s.newlyOnsetHa, placement: context.place(c.lon, c.lat), cell: r.cell.id, beforeSeries: r.month < SERIES_START },
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(historyEvents).values(rows.slice(i, i + 200)).onConflictDoNothing();
  }
  // Progress per cell and month (the home page's scan meter and the backfill's resume report read it).
  const cover = Math.round((r.coverage.sentinel2 + r.coverage.landsat) * 100);
  await db
    .insert(historyProgress)
    .values({ cellId: r.cell.id, scanMonth: r.month, status: "ok", sites: r.sites.length, coverageAfter: cover, note: `gw-ts: optical ${cover}%, radar only ${Math.round(r.coverage.radar * 100)}%` })
    .onConflictDoUpdate({ target: [historyProgress.cellId, historyProgress.scanMonth], set: { status: sql`excluded.status`, sites: sql`excluded.sites`, coverageAfter: sql`excluded.coverage_after`, note: sql`excluded.note`, scannedAt: sql`now()` } });
}

/** Detections of this method in the cell that the latest month no longer shows are hidden (not deleted). */
async function dismissGone(db: Db, cellId: string, keep: string[], now: Date) {
  await db.execute(sql`update change_events set status = 'dismissed',
      properties = coalesce(properties, '{}'::jsonb) || jsonb_build_object('autoDismissed', ${`no longer mined in the monthly record on ${now.toISOString().slice(0, 10)}`}::text)
    where method_version = ${METHOD} and status = 'new' and properties->>'cell' = ${cellId}::text
      and source_event_id not in (select jsonb_array_elements_text(${JSON.stringify(keep)}::text::jsonb))`);
}
