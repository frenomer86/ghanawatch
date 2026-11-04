import { asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Polygon } from "geojson";
import { alertCells, analysisCells } from "@/lib/db/schema";
import { lonLatToTile, tilePixelM, tileToLonLat } from "@/lib/server/land/plot";
import { corridor, edgeShare, fmtLength as km, isRoadShape, patchShape, ROAD_MAX_EDGE_SHARE } from "../tracks/shape";
import type { Adapter, NormalisedEvent } from "./types";

/**
 * Global Forest Watch integrated deforestation alerts for all of Ghana, read
 * from GFW's public map tiles (no key). The layer combines three published
 * systems: GLAD-L (Landsat, University of Maryland), GLAD-S2 (Sentinel-2) and
 * RADD (Sentinel-1 radar, Wageningen University), so it also sees through
 * cloud. Each tile pixel carries the alert date (red × 255 + green, days since
 * 2014-12-31) and confidence (blue in hundreds: 1 = one system, low; 2 = high,
 * confirmed by repeat observations or several systems).
 *
 * Alerts from the last ALERT_DAYS are grouped into patches; patches of at
 * least MIN_HA become vegetation-loss detections. High-confidence patches are
 * "high" confidence here; single-system patches are "low" and hidden from the
 * default views.
 *
 * A patch shaped like a track (src/pipeline/tracks/shape.ts) becomes a "new road"
 * detection, whatever its area: a fresh track cut into forest is often the first
 * sign of galamsey or logging, before any pit appears. Its outline is a narrow
 * corridor along the track's centre line rather than the patch's box, and
 * src/pipeline/context/roads.ts then ties it to the forest reserve it enters or
 * approaches. A pit or farm that grows adds a thin strip of new alerts along
 * its edge, which has the same shape; a strip lying mostly against tree cover
 * lost earlier (older alerts in the same layer) is that, and is not taken for a
 * track.
 */
const SLUG = "gfw-integrated-alerts";
const METHOD = "gfw-integrated-1.0";
const Z = 14;
const ALERT_DAYS = 120;
const MIN_HA = 0.25;
const EPOCH = Date.UTC(2014, 11, 31);
const TILE = (x: number, y: number) => `https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/default/${Z}/${x}/${y}.png`;
const USER_AGENT = "GhanaWatch/0.1 (environmental monitoring)";

export const gfwAlertsAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 24,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    const budgetMs = Number(process.env.GFW_ALERTS_BUDGET_MINUTES ?? 30) * 60_000;
    const started = Date.now();
    const stale = new Date(ctx.now.getTime() - 6 * 86_400_000);
    const cells = await db
      .select({ id: analysisCells.id, minLon: analysisCells.minLon, minLat: analysisCells.minLat, maxLon: analysisCells.maxLon, maxLat: analysisCells.maxLat })
      .from(analysisCells)
      .leftJoin(alertCells, eq(alertCells.cellId, analysisCells.id))
      .where(or(isNull(alertCells.lastRunAt), lt(alertCells.lastRunAt, stale)))
      .orderBy(desc(analysisCells.priority), asc(alertCells.lastRunAt));
    const since = ctx.now.getTime() - ALERT_DAYS * 86_400_000;
    const events: NormalisedEvent[] = [];
    let done = 0;
    const notes: string[] = [];
    for (const c of cells) {
      if (Date.now() - started > budgetMs) break;
      try {
        const { patches, tiles } = await scanCell([c.minLon, c.minLat, c.maxLon, c.maxLat], since);
        const evs = patches.filter((p) => p.areaHa >= MIN_HA || p.road).map((p) => toEvent(p, ctx.now));
        if (ctx.emit) await ctx.emit(evs);
        else events.push(...evs);
        await db
          .insert(alertCells)
          .values({ cellId: c.id, lastRunAt: ctx.now, alerts: evs.length, tiles })
          .onConflictDoUpdate({ target: alertCells.cellId, set: { lastRunAt: ctx.now, alerts: evs.length, tiles } });
        done++;
        ctx.log(`${SLUG}: cell ${c.id}: ${evs.length} alert patches of ${MIN_HA} ha or more (${tiles} tiles)`);
      } catch (e) {
        notes.push(`${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (cells.length > done) notes.push(`${cells.length - done} cells left for the next run`);
    return { events, notes, extra: { cells: done } };
  },
};

export interface AlertPatch {
  lon: number;
  lat: number;
  areaHa: number;
  pixels: number;
  high: number;
  first: string;
  last: string;
  bbox: [number, number, number, number];
  /** Set when the patch is shaped like a track: its length, width and centre line (lon, lat). */
  road?: { lengthM: number; widthM: number; line: Array<[number, number]> };
}

async function scanCell(bbox: [number, number, number, number], since: number): Promise<{ patches: AlertPatch[]; tiles: number }> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const tl = lonLatToTile(minLon, maxLat, Z);
  const br = lonLatToTile(maxLon, minLat, Z);
  const jobs: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(tl.x); x <= Math.floor(br.x); x++) for (let y = Math.floor(tl.y); y <= Math.floor(br.y); y++) jobs.push({ x, y });
  const patches: AlertPatch[] = [];
  for (let i = 0; i < jobs.length; i += 6) {
    const batch = await Promise.all(jobs.slice(i, i + 6).map((j) => readTile(j.x, j.y, since)));
    batch.forEach((grid, k) => {
      if (grid) patches.push(...patchesInTile(grid, jobs[i + k].x, jobs[i + k].y).filter((p) => p.lon >= minLon && p.lon < maxLon && p.lat >= minLat && p.lat < maxLat));
    });
  }
  return { patches, tiles: jobs.length };
}

/**
 * Per pixel: 0 none; -1 tree cover lost before `since` (an older alert, kept to tell a new track from the new edge of
 * an old clearing); else the day index (days since EPOCH) and confidence, packed as day * 4 + confidence. Null when
 * the tile has no alert since `since`.
 */
async function readTile(x: number, y: number, since: number): Promise<Int32Array | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(TILE(x, y), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sharp = (await import("sharp")).default;
      const { data } = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const out = new Int32Array(256 * 256);
      let any = false;
      for (let p = 0; p < out.length; p++) {
        const o = p * 4;
        if (!data[o + 3]) continue;
        const day = data[o] * 255 + data[o + 1];
        if (day <= 0) continue;
        if (EPOCH + day * 86_400_000 < since) {
          out[p] = -1;
          continue;
        }
        out[p] = day * 4 + Math.max(1, Math.min(3, Math.floor(data[o + 2] / 100)));
        any = true;
      }
      return any ? out : null;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

/** 8-connected patches of new alert pixels in one tile (pure; exported for tests). */
export function patchesInTile(grid: Int32Array, tx: number, ty: number): AlertPatch[] {
  const seen = new Uint8Array(grid.length);
  const out: AlertPatch[] = [];
  const stack: number[] = [];
  for (let s = 0; s < grid.length; s++) {
    if (grid[s] <= 0 || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    const pc: number[] = [];
    const pr: number[] = [];
    let n = 0;
    let high = 0;
    let sx = 0;
    let sy = 0;
    let dMin = Infinity;
    let dMax = 0;
    let c0 = 256;
    let r0 = 256;
    let c1 = 0;
    let r1 = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const col = p % 256;
      const row = (p - col) / 256;
      pc.push(col);
      pr.push(row);
      const day = Math.floor(grid[p] / 4);
      if (grid[p] % 4 >= 2) high++;
      n++;
      sx += col;
      sy += row;
      dMin = Math.min(dMin, day);
      dMax = Math.max(dMax, day);
      c0 = Math.min(c0, col);
      r0 = Math.min(r0, row);
      c1 = Math.max(c1, col);
      r1 = Math.max(r1, row);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cc = col + dx;
          const rr = row + dy;
          if (cc < 0 || rr < 0 || cc > 255 || rr > 255) continue;
          const q = rr * 256 + cc;
          if (grid[q] <= 0 || seen[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    const centre = tileToLonLat(tx + (sx / n + 0.5) / 256, ty + (sy / n + 0.5) / 256, Z);
    const nw = tileToLonLat(tx + c0 / 256, ty + r0 / 256, Z);
    const se = tileToLonLat(tx + (c1 + 1) / 256, ty + (r1 + 1) / 256, Z);
    const pxHa = tilePixelM(Z, 256, centre.lat) ** 2 / 10_000;
    const iso = (d: number) => new Date(EPOCH + d * 86_400_000).toISOString().slice(0, 10);
    const patch: AlertPatch = { lon: centre.lon, lat: centre.lat, areaHa: n * pxHa, pixels: n, high, first: iso(dMin), last: iso(dMax), bbox: [nw.lon, se.lat, se.lon, nw.lat] };
    if (n >= 15) {
      const pxM = tilePixelM(Z, 256, centre.lat);
      const sh = patchShape(pc, pr);
      const lengthM = sh.lengthPx * pxM;
      const widthM = sh.widthPx * pxM;
      if (isRoadShape(lengthM, widthM) && edgeShare((i) => grid[i] < 0, 256, 256, pc, pr) <= ROAD_MAX_EDGE_SHARE) {
        const line = sh.line.map(([c, r]) => {
          const ll = tileToLonLat(tx + c / 256, ty + r / 256, Z);
          return [Math.round(ll.lon * 1e6) / 1e6, Math.round(ll.lat * 1e6) / 1e6] as [number, number];
        });
        patch.road = { lengthM: Math.round(lengthM), widthM: Math.round(widthM), line };
      }
    }
    out.push(patch);
  }
  return out;
}

function toEvent(p: AlertPatch, now: Date): NormalisedEvent {
  if (p.road) return roadEvent(p, p.road, now);
  const confirmed = p.high / p.pixels >= 0.5;
  const ha = Math.round(p.areaHa * 100) / 100;
  const sourceEventId = `ia-${p.lon.toFixed(4)}-${p.lat.toFixed(4)}`;
  const [w, s, e, n] = p.bbox;
  const geom: Polygon = { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  return {
    sourceSlug: SLUG,
    sourceEventId,
    type: "vegetation_loss",
    detectedAt: now,
    imageDate: p.first,
    imageDateEnd: p.last,
    confidence: confirmed ? "high" : "low",
    confidenceScore: confirmed ? 0.9 : 0.5,
    severity: confirmed ? (ha >= 5 ? "elevated" : "watch") : "normal",
    areaHa: ha,
    geom,
    titleEn: `Forest or tree cover cleared, about ${ha >= 10 ? Math.round(ha) : ha.toFixed(1)} ha`,
    descriptionEn: `Global Forest Watch's integrated deforestation alerts (GLAD-L from Landsat, GLAD-S2 from Sentinel-2, and RADD from Sentinel-1 radar, which sees through cloud) flag about ${ha} ha of tree cover lost here between ${p.first} and ${p.last}. ${
      confirmed
        ? "Most of the patch is high confidence: confirmed by repeated observations or by more than one system."
        : "The patch is low confidence (seen by one system once) and may still be confirmed or dropped."
    } Clearing for mining, farms, plantations, roads or fire all show up this way; check the satellite views before acting.`,
    methodVersion: METHOD,
    properties: { alertPixels: p.pixels, highConfidencePixels: p.high, firstAlert: p.first, lastAlert: p.last, zoom: Z },
  };
}

function roadEvent(p: AlertPatch, road: NonNullable<AlertPatch["road"]>, now: Date): NormalisedEvent {
  const confirmed = p.high / p.pixels >= 0.5;
  return {
    sourceSlug: SLUG,
    sourceEventId: `road-${p.lon.toFixed(4)}-${p.lat.toFixed(4)}`,
    type: "vegetation_loss",
    detectedAt: now,
    imageDate: p.first,
    imageDateEnd: p.last,
    confidence: confirmed ? "high" : "low",
    confidenceScore: confirmed ? 0.85 : 0.5,
    severity: "watch",
    areaHa: Math.round(p.areaHa * 100) / 100,
    geom: corridor(road.line, Math.max(8, road.widthM / 2)),
    titleEn: `New track cut through forest, about ${km(road.lengthM)}`,
    descriptionEn: `A line of tree cover about ${km(road.lengthM)} long and ${road.widthM} m wide was cleared here between ${p.first} and ${p.last}, according to Global Forest Watch's integrated deforestation alerts (Landsat, Sentinel-2 and Sentinel-1 radar). Its shape is that of a track or road. New tracks into forest often come before mining pits or logging; check the satellite views and the forest reserve it leads to. ${
      confirmed ? "Most of it is high confidence, confirmed by repeated observations or by more than one system." : "It is low confidence so far (seen by one system once)."
    }`,
    methodVersion: METHOD,
    properties: { signature: "new_road", lengthM: road.lengthM, widthM: road.widthM, line: road.line, alertPixels: p.pixels, highConfidencePixels: p.high, firstAlert: p.first, lastAlert: p.last, zoom: Z },
  };
}
