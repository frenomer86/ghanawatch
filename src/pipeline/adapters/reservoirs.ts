import proj4 from "proj4";
import { and, desc, eq, sql } from "drizzle-orm";
import type { MultiPolygon, Polygon, Position } from "geojson";
import type { Db } from "@/lib/db/client";
import { reservoirObservations, reservoirs } from "@/lib/db/schema";
import { RESERVOIRS, waterThreshold, type ReservoirDef } from "@/lib/domain/reservoirs";
import { makeGrid, type Grid } from "../s2/cog";
import { readRadarDb, sasToken, searchRadar, type RadarScene } from "../s1/pc";
import { dilate, rasterise, simplifyPolygon, vertexCount } from "../reservoirs/geometry";
import type { Adapter, AdapterContext } from "./types";

/**
 * How much of each of Ghana's main reservoirs and lakes is under water, from every Sentinel-1 radar pass
 * (radar sees through the cloud that hides Ghana's southern reservoirs from Landsat and Sentinel-2 for months).
 *
 * For each water body in src/lib/domain/reservoirs.ts, the outline of its largest extent (Digital Earth Africa
 * Waterbodies, fetched once) is simplified to the radar grid and filled onto the scene's UTM grid; the VH
 * backscatter of every frame of the pass is read at that grid (a coarse overview for Lake Volta) and the frames
 * mosaicked; Otsu's threshold over the outline and a 300 m band of land around it (bounded to -28 .. -16 dB,
 * -22 dB when the histogram is not bimodal) separates open water from land and exposed shore. VH rather than
 * VV, because wind roughens open water far more in VV. A pass that sees less than 60% of the outline is
 * skipped. The first run goes back a year; later runs pick up each new pass. The page shows a running median
 * of three passes, not single passes.
 */
export const SLUG = "s1-reservoirs";
export const METHOD = "s1-reservoirs-1.0";
const WFS = "https://geoserver.digitalearth.africa/geoserver/wfs";
const MIN_OBSERVED = 0.6;
const BACKFILL_DAYS = 365;
/** At most this many passes per run, in all and per water body, so the first year arrives over a few runs. */
const MAX_PASSES_PER_RUN = 80;
const MAX_PASSES_PER_BODY = 25;
/** The radar catalogue returns at most 100 frames per search, so long periods are searched in slices. */
const SEARCH_SLICE_DAYS = 45;
const DAY = 86_400_000;

type Fetch = AdapterContext["fetchJson"];

function ensureUtm(epsg: number) {
  const name = `EPSG:${epsg}`;
  if (!proj4.defs(name)) proj4.defs(name, `+proj=utm +zone=${epsg % 100}${epsg >= 32700 ? " +south" : ""} +datum=WGS84 +units=m +no_defs`);
  return proj4("EPSG:4326", name);
}

/** The outline of a water body's largest extent, from Digital Earth Africa, simplified for its radar grid. */
export async function fetchOutline(fetchJson: Fetch, def: ReservoirDef): Promise<{ geom: MultiPolygon; areaKm2: number; bbox: [number, number, number, number] }> {
  const q = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "waterbodies:DEAfrica_Waterbodies",
    outputFormat: "application/json",
    CQL_FILTER: `wb_id=${def.wbId}`,
  });
  const res = await fetchJson<{ features?: Array<{ geometry: Polygon | MultiPolygon | null; properties: { area_m2?: number } }> }>(`${WFS}?${q}`);
  const f = res.features?.[0];
  if (!f?.geometry) throw new Error(`${def.slug}: no outline for waterbody ${def.wbId}`);
  // Half the grid resolution, in degrees: finer detail than that cannot change which pixels are filled.
  const geom = simplifyPolygon(f.geometry, def.resM / 2 / 111_320);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of geom.coordinates) for (const [x, y] of p[0]) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { geom, areaKm2: (f.properties.area_m2 ?? 0) / 1e6, bbox: [minX, minY, maxX, maxY] };
}

/** Radar frames grouped into passes (one satellite, one orbit direction, one day), oldest first. */
export function passesOf(scenes: RadarScene[]): Array<{ date: string; orbit: RadarScene["orbit"]; scenes: RadarScene[] }> {
  const by = new Map<string, { date: string; orbit: RadarScene["orbit"]; scenes: RadarScene[] }>();
  for (const s of scenes) {
    const date = s.datetime.slice(0, 10);
    const key = `${date}|${s.orbit}|${s.platform}`;
    let p = by.get(key);
    if (!p) by.set(key, (p = { date, orbit: s.orbit, scenes: [] }));
    p.scenes.push(s);
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface PassResult {
  waterKm2: number;
  waterPct: number;
  observedPct: number;
  thresholdDb: number;
}

/**
 * Water inside an outline mask from a mosaicked VH grid (pure; exported for tests). `band` marks the land
 * around the outline that joins the threshold's histogram.
 */
export function measure(vh: Float32Array, mask: Uint8Array, maskPx: number, pxKm2: number, extentKm2: number, band?: Uint8Array): PassResult | null {
  const inside: number[] = [];
  const sample: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!Number.isFinite(vh[i])) continue;
    if (mask[i]) {
      inside.push(vh[i]);
      sample.push(vh[i]);
    } else if (band?.[i]) sample.push(vh[i]);
  }
  const observed = inside.length / Math.max(1, maskPx);
  if (observed < MIN_OBSERVED) return null;
  const thr = waterThreshold(sample);
  let wet = 0;
  for (const v of inside) if (v < thr) wet++;
  const share = wet / inside.length;
  // The outline filled on the grid is not exactly the outline's own area; scale to the published extent.
  const scale = extentKm2 > 0 ? extentKm2 / (maskPx * pxKm2) : 1;
  return {
    waterKm2: Math.round(share * maskPx * pxKm2 * scale * 100) / 100,
    waterPct: Math.round(share * 1000) / 10,
    observedPct: Math.round(observed * 1000) / 10,
    thresholdDb: thr,
  };
}

async function measurePass(
  fetchJson: Fetch,
  def: ReservoirDef,
  outline: { geom: MultiPolygon; areaKm2: number; bbox: [number, number, number, number] },
  pass: { scenes: RadarScene[] },
): Promise<PassResult | null> {
  const sas = await sasToken(fetchJson);
  const epsg = pass.scenes[0].epsg;
  const conv = ensureUtm(epsg);
  const [w, s, e, n] = outline.bbox;
  const corners = [conv.forward([w, s]), conv.forward([e, s]), conv.forward([w, n]), conv.forward([e, n])];
  const grid: Grid = makeGrid(
    [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
    def.resM,
  );
  const toPx = ([lon, lat]: Position): Position => {
    const [x, y] = conv.forward([lon, lat]);
    return [(x - grid.bbox[0]) / grid.res, (grid.bbox[3] - y) / grid.res];
  };
  const rings = outline.geom.coordinates.flatMap((p) => p.map((r) => r.map(toPx)));
  const mask = rasterise(rings, grid.width, grid.height);
  let maskPx = 0;
  for (let i = 0; i < mask.length; i++) maskPx += mask[i];
  if (!maskPx) return null;
  // Frames in another UTM zone than the first are left out; Ghana's reservoirs sit within one zone per pass.
  const frames = pass.scenes.filter((sc) => sc.epsg === epsg);
  const reads = (await Promise.all(frames.map((sc) => readRadarDb(sc.vh, sas, grid).catch(() => null)))).filter((x): x is Float32Array => x !== null);
  if (!reads.length) return null;
  const vh = reads[0];
  for (const r of reads.slice(1)) for (let i = 0; i < vh.length; i++) if (!Number.isFinite(vh[i]) && Number.isFinite(r[i])) vh[i] = r[i];
  // A band of land about 300 m wide (at least three pixels) around the outline.
  const k = Math.max(3, Math.round(300 / grid.res));
  const grown = dilate(mask, grid.width, grid.height, k);
  const band = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) band[i] = grown[i] && !mask[i] ? 1 : 0;
  return measure(vh, mask, maskPx, (grid.res * grid.res) / 1e6, outline.areaKm2, band);
}

async function outlineFor(db: Db, fetchJson: Fetch, def: ReservoirDef, log: (s: string) => void) {
  const [row] = await db.select().from(reservoirs).where(eq(reservoirs.slug, def.slug)).limit(1);
  if (row && row.wbId === def.wbId) return { geom: row.geom, areaKm2: row.areaKm2, bbox: row.bbox };
  const o = await fetchOutline(fetchJson, def);
  await db
    .insert(reservoirs)
    .values({ slug: def.slug, wbId: def.wbId, name: def.name, areaKm2: o.areaKm2, geom: o.geom, bbox: o.bbox })
    .onConflictDoUpdate({ target: reservoirs.slug, set: { wbId: def.wbId, name: def.name, areaKm2: o.areaKm2, geom: o.geom, bbox: o.bbox, updatedAt: new Date() } });
  log(`${SLUG}: ${def.name} outline, ${o.areaKm2.toFixed(1)} km², ${vertexCount(o.geom)} vertices after simplifying`);
  return o;
}

export const reservoirsAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 12,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    let budget = MAX_PASSES_PER_RUN;
    let added = 0;
    let skipped = 0;
    // Small water bodies first: they are cheap, and Lake Volta then takes what is left of the run.
    const only = process.env.GW_RESERVOIRS?.split(",").filter(Boolean);
    for (const def of [...RESERVOIRS].filter((d) => !only?.length || only.includes(d.slug)).sort((a, b) => a.resM - b.resM)) {
      if (budget <= 0) break;
      let outline;
      try {
        outline = await outlineFor(db, ctx.fetchJson, def, ctx.log);
      } catch (e) {
        ctx.log(`${SLUG}: ${def.name} outline unavailable: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const [last] = await db.select({ date: reservoirObservations.date }).from(reservoirObservations).where(eq(reservoirObservations.slug, def.slug)).orderBy(desc(reservoirObservations.date)).limit(1);
      const from = last ? new Date(Date.parse(`${last.date}T00:00:00Z`) + DAY) : new Date(ctx.now.getTime() - BACKFILL_DAYS * DAY);
      if (from > ctx.now) continue;
      const scenes: RadarScene[] = [];
      for (let t = from.getTime(); t < ctx.now.getTime(); t += SEARCH_SLICE_DAYS * DAY) {
        scenes.push(...(await searchRadar(ctx.fetchJson, { bbox: outline.bbox }, new Date(t), new Date(Math.min(ctx.now.getTime(), t + SEARCH_SLICE_DAYS * DAY)))));
      }
      // Backfilling, take one pass per orbit direction every 12 days; afterwards, every pass.
      let passes = passesOf(scenes);
      if (!last) {
        const seen = new Map<string, number>();
        passes = passes.filter((p) => {
          const t = Date.parse(`${p.date}T00:00:00Z`);
          const prev = seen.get(p.orbit);
          if (prev != null && t - prev < 11 * DAY) return false;
          seen.set(p.orbit, t);
          return true;
        });
      }
      let mine = MAX_PASSES_PER_BODY;
      for (const p of passes) {
        if (budget-- <= 0 || mine-- <= 0) break;
        let r: PassResult | null = null;
        try {
          r = await measurePass(ctx.fetchJson, def, outline, p);
        } catch (e) {
          ctx.log(`${SLUG}: ${def.name} ${p.date} failed: ${e instanceof Error ? e.message : e}`);
        }
        if (!r) {
          skipped++;
          continue;
        }
        await db
          .insert(reservoirObservations)
          .values({ slug: def.slug, date: p.date, orbit: p.orbit, ...r, scenes: p.scenes.length, method: METHOD })
          .onConflictDoUpdate({
            target: [reservoirObservations.slug, reservoirObservations.date, reservoirObservations.orbit],
            set: { waterKm2: sql`excluded.water_km2`, waterPct: sql`excluded.water_pct`, observedPct: sql`excluded.observed_pct`, thresholdDb: sql`excluded.threshold_db`, scenes: sql`excluded.scenes`, method: sql`excluded.method` },
          });
        added++;
      }
    }
    ctx.log(`${SLUG}: ${added} passes measured, ${skipped} skipped (too little of the outline seen)`);
    return { events: [], watermark: ctx.now, extra: { added, skipped } };
  },
};

/** Observations of one water body, oldest first (for the page). */
export async function observationsFor(db: Db, slug: string, sinceDays = 400) {
  return db
    .select()
    .from(reservoirObservations)
    .where(and(eq(reservoirObservations.slug, slug), sql`${reservoirObservations.date} >= current_date - ${sinceDays}`))
    .orderBy(reservoirObservations.date);
}
