import { asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import { rows as toRows, type Db } from "@/lib/db/client";
import { trackBoxes } from "@/lib/db/schema";
import { pointInPolygon } from "@/lib/geo";
import { stableId } from "@/lib/server/ids";
import { edgeDistanceM } from "../context/roads";
import { sourceId } from "../seed/sources";
import type { SceneBands } from "../s2/analysis";
import { VALID_SCL } from "../s2/analysis";
import { makeGrid, type Grid } from "../s2/cog";
import { epsgFor, fromProj, loadScene, toProj } from "../s2/process";
import { searchScenes, type Scene } from "../s2/stac";
import { findTracks, openedMask, TrackAccumulator, type TrackFound } from "../tracks/detect";
import { corridor, fmtLength } from "../tracks/shape";
import type { Adapter, AdapterContext, NormalisedEvent } from "./types";

/**
 * New tracks into forest reserves, from GhanaWatch's own 10 m Sentinel-2 scan (src/pipeline/tracks/detect.ts).
 *
 * The national scans read Sentinel-2 at 20 or 40 m, too coarse for a track a few metres wide, and Global
 * Forest Watch's alerts rarely keep one as a line; at 10 m a new track through closed forest shows plainly as
 * a thin line of bare laterite. Scanning all of southern Ghana at 10 m every month would be too heavy, so this
 * scan covers the forest reserves and other protected areas (OpenStreetMap outlines in context_features) and
 * a band of ZONE_M around them, where a track is the warning that matters. The zone is cut into boxes of
 * BOX_DEG; each box compares the clearest scenes of the last 120 days with the clearest one to two years
 * earlier, and is scanned again after RESCAN_DAYS. A run stops after GW_TRACKS_BUDGET_MINUTES (45) and goes on
 * from where it stopped the next day.
 *
 * Each track becomes a "new road" detection (properties.signature new_road) with its centre line;
 * src/pipeline/context/roads.ts then names the reserve it enters or approaches and sets its level.
 */
const SLUG = "s2-forest-tracks";
const METHOD = "s2-tracks-1.0";
const BOX_DEG = 0.1;
const ORIGIN = { lon: -3.5, lat: 4.5 };
const ZONE_M = 2000;
const RESCAN_DAYS = 30;
const WINDOW_DAYS = 120;
const MAX_AFTER = 7;
const MAX_BEFORE = 8;
const RES = 10;
const DAY = 86_400_000;

interface Area {
  geom: Polygon | MultiPolygon;
  bbox: [number, number, number, number];
}

const boxId = (ix: number, iy: number) => `t${ix}_${iy}`;
const boxBbox = (ix: number, iy: number): [number, number, number, number] => [
  +(ORIGIN.lon + ix * BOX_DEG).toFixed(4),
  +(ORIGIN.lat + iy * BOX_DEG).toFixed(4),
  +(ORIGIN.lon + (ix + 1) * BOX_DEG).toFixed(4),
  +(ORIGIN.lat + (iy + 1) * BOX_DEG).toFixed(4),
];

/** The boxes that hold some of a protected area or the band of ZONE_M around it (pure; exported for tests). */
export function boxesForAreas(areas: Area[]): Array<{ id: string; bbox: [number, number, number, number] }> {
  const pad = ZONE_M / 111_000;
  const keep = new Map<string, [number, number, number, number]>();
  for (const a of areas) {
    const [w, s, e, n] = a.bbox;
    for (let ix = Math.floor((w - pad - ORIGIN.lon) / BOX_DEG); ix <= Math.floor((e + pad - ORIGIN.lon) / BOX_DEG); ix++) {
      for (let iy = Math.floor((s - pad - ORIGIN.lat) / BOX_DEG); iy <= Math.floor((n + pad - ORIGIN.lat) / BOX_DEG); iy++) {
        const id = boxId(ix, iy);
        if (keep.has(id)) continue;
        const b = boxBbox(ix, iy);
        // A small area wholly inside the box, or the box reaching into the area or its band.
        const ring = a.geom.type === "Polygon" ? a.geom.coordinates[0] : a.geom.coordinates[0][0];
        let hit = ring.some(([x, y]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
        for (let i = 0; i <= 4 && !hit; i++) {
          for (let j = 0; j <= 4 && !hit; j++) {
            const x = b[0] + ((b[2] - b[0]) * i) / 4;
            const y = b[1] + ((b[3] - b[1]) * j) / 4;
            hit = pointInPolygon([x, y], a.geom) || edgeDistanceM(x, y, a.geom) <= ZONE_M + (BOX_DEG * 111_000) / 8;
          }
        }
        if (hit) keep.set(id, b);
      }
    }
  }
  return [...keep.entries()].map(([id, bbox]) => ({ id, bbox }));
}

async function loadAreas(db: Db): Promise<Area[]> {
  return toRows<{ geom: Polygon | MultiPolygon; w: number; s: number; e: number; n: number }>(
    await db.execute(sql`
      select geom, bbox_min_lon::float as w, bbox_min_lat::float as s, bbox_max_lon::float as e, bbox_max_lat::float as n
      from context_features where kind = 'protected_area' and geom is not null and bbox_min_lon is not null`),
  )
    .filter((r) => r.geom.type === "Polygon" || r.geom.type === "MultiPolygon")
    .map((r) => ({ geom: r.geom, bbox: [r.w, r.s, r.e, r.n] }));
}

function pick(scenes: Scene[], epsg: number, max: number): Scene[] {
  const same = scenes.filter((s) => s.epsg === epsg);
  const other = scenes.filter((s) => s.epsg !== epsg);
  return (same.length ? same : other).sort((a, b) => a.cloud - b.cloud).slice(0, max);
}

interface BoxScan {
  epsg: number;
  grid: Grid;
  tracks: TrackFound[];
  after: Scene[];
  before: Scene[];
  /** Per scene id, its scene classification on the grid, to choose the clearest view of each track. */
  scl: Map<string, SceneBands["scl"]>;
  clearShare: number;
}

async function composite(scenes: Scene[], grid: Grid, scl: Map<string, SceneBands["scl"]>, log: (m: string) => void) {
  const acc = new TrackAccumulator(grid.width * grid.height, scenes.length);
  let failed = 0;
  for (let i = 0; i < scenes.length; i += 3) {
    const batch = await Promise.all(
      scenes.slice(i, i + 3).map((s) =>
        loadScene(s, grid).catch((e) => {
          failed++;
          log(`${SLUG}:   scene ${s.id} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
      ),
    );
    for (const b of batch) {
      if (!b) continue;
      acc.add(b);
      scl.set(b.sceneId, b.scl);
    }
  }
  if (scenes.length >= 3 && failed > scenes.length / 2) throw new Error(`only ${scenes.length - failed} of ${scenes.length} scenes could be read (network problem); will rescan`);
  return acc.finish();
}

async function scanBox(bbox: [number, number, number, number], now: Date, fetchJson: AdapterContext["fetchJson"], log: (m: string) => void): Promise<BoxScan | null> {
  let epsg = epsgFor((bbox[0] + bbox[2]) / 2);
  const recent = await searchScenes(fetchJson, bbox, new Date(now.getTime() - WINDOW_DAYS * DAY), now, 80);
  const older = await searchScenes(fetchJson, bbox, new Date(now.getTime() - 730 * DAY), new Date(now.getTime() - 365 * DAY), 60);
  const after = pick(recent, epsg, MAX_AFTER);
  if (after.length && after[0].epsg !== epsg) epsg = after[0].epsg;
  const before = pick(older, epsg, MAX_BEFORE);
  if (after.length < 2 || before.length < 2) return null;
  const corners = [toProj(epsg, bbox[0], bbox[1]), toProj(epsg, bbox[2], bbox[1]), toProj(epsg, bbox[0], bbox[3]), toProj(epsg, bbox[2], bbox[3])];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const grid = makeGrid([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], RES);
  const scl = new Map<string, SceneBands["scl"]>();
  const A = await composite(after, grid, scl, log);
  const B = await composite(before, grid, scl, log);
  let clear = 0;
  for (let i = 0; i < A.count.length; i++) if (A.count[i] >= 2) clear++;
  const tracks = findTracks(openedMask(B, A), B, A, grid.width, grid.height, RES);
  return { epsg, grid, tracks, after, before, scl, clearShare: clear / A.count.length };
}

function clearest(scenes: Scene[], scl: BoxScan["scl"], cells: number[]): Scene | null {
  let best: { s: Scene; f: number } | null = null;
  for (const s of scenes) {
    const c = scl.get(s.id);
    if (!c) continue;
    let ok = 0;
    for (const p of cells) if (VALID_SCL.has(c[p])) ok++;
    const f = ok / cells.length;
    if (!best || f > best.f) best = { s, f };
  }
  return best && best.f > 0 ? best.s : null;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110_540);

/** The same track found again on a later pass keeps its detection: any point within 50 m of its earlier line. */
export function sameTrack(line: Array<[number, number]>, earlier: Array<[number, number]>): boolean {
  return line.some((p) => earlier.some((q) => dist(p, q) <= 50));
}

/** A track's centre line in longitude and latitude. */
function lineOf(scan: BoxScan, t: TrackFound): Array<[number, number]> {
  const { epsg, grid } = scan;
  return t.line.map(([c, r]) => {
    const [lon, lat] = fromProj(epsg, grid.bbox[0] + c * grid.res, grid.bbox[3] - r * grid.res);
    return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] as [number, number];
  });
}

function toEvent(scan: BoxScan, t: TrackFound, line: Array<[number, number]>, boxIdText: string, sourceEventId: string, now: Date): NormalisedEvent {
  const id = stableId("event", `${SLUG}:${sourceEventId}`);
  const licence = "Copernicus Sentinel data terms (free, full and open)";
  const images: NonNullable<NormalisedEvent["images"]> = [];
  for (const [role, s] of [
    ["latest", clearest(scan.after, scan.scl, t.cells)],
    ["before", clearest(scan.before, scan.scl, t.cells)],
  ] as const) {
    if (!s) continue;
    images.push({
      role,
      sourceSlug: SLUG,
      productId: s.id,
      sensor: "Sentinel-2 MSI",
      acquiredAt: new Date(s.datetime),
      cloudCoverPct: Math.round(s.cloud * 10) / 10,
      thumbnailUrl: `/api/v1/events/${id}/image?role=${role}`,
      tileUrlTemplate: s.assets.visual,
      licence,
    });
  }
  const dates = scan.after.map((s) => s.datetime.slice(0, 10)).sort();
  const beforeMonth = scan.before.map((s) => s.datetime.slice(0, 7)).sort().at(-1) ?? "the baseline";
  const high = t.openObs >= 3;
  return {
    sourceSlug: SLUG,
    sourceEventId,
    type: "vegetation_loss",
    detectedAt: now,
    imageDate: dates.at(-1)!,
    confidence: high ? "high" : "medium",
    confidenceScore: high ? 0.85 : 0.7,
    severity: "watch",
    areaHa: Math.round(t.pixels * (RES * RES) / 100) / 100,
    geom: corridor(line, Math.max(8, t.widthM / 2)),
    titleEn: `New track cut through forest, about ${fmtLength(t.lengthM)}`,
    titleTw: "Kwan foforɔ a wɔatwa afa kwaeɛ mu",
    descriptionEn: `Sentinel-2 imagery at 10 m shows a line about ${fmtLength(t.lengthM)} long and ${t.widthM} m wide opened through forest that stood in imagery from ${beforeMonth} and earlier; it shows bare soil on about ${t.openObs} clear views of the last ${WINDOW_DAYS} days. Its shape is that of a track or road (a line of clearing for pits can look the same). New tracks into forest often come before mining or logging. This is a detected change, not a legal finding; ground verification is encouraged.`,
    descriptionTw: "Satellite kyerɛ kwan foforɔ a wɔatwa afa kwaeɛ mu. Ɛtaa di sikatutu anaa nnua twa anim.",
    methodVersion: METHOD,
    properties: {
      signature: "new_road",
      lengthM: t.lengthM,
      widthM: t.widthM,
      line,
      pixels: t.pixels,
      meanOpenObservations: t.openObs,
      edgeShare: t.edge,
      box: boxIdText,
      resolutionM: RES,
      baselineScenes: scan.before.length,
      recentScenes: scan.after.length,
    },
    images,
  };
}

export const forestTracksAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 24,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    const areas = await loadAreas(db);
    if (!areas.length) return { events: [], notes: ["no protected-area outlines loaded yet (OpenStreetMap context); nothing to scan"] };
    const boxes = boxesForAreas(areas);
    for (let i = 0; i < boxes.length; i += 500) {
      await db
        .insert(trackBoxes)
        .values(boxes.slice(i, i + 500).map((b) => ({ boxId: b.id, minLon: b.bbox[0], minLat: b.bbox[1], maxLon: b.bbox[2], maxLat: b.bbox[3] })))
        .onConflictDoNothing();
    }
    const live = new Set(boxes.map((b) => b.id));
    const due = (
      await db
        .select()
        .from(trackBoxes)
        .where(or(isNull(trackBoxes.lastRunAt), lt(trackBoxes.lastRunAt, new Date(ctx.now.getTime() - RESCAN_DAYS * DAY))))
        .orderBy(sql`${trackBoxes.lastRunAt} asc nulls first`, asc(trackBoxes.boxId))
    ).filter((b) => live.has(b.boxId));
    const budgetMs = Number(process.env.GW_TRACKS_BUDGET_MINUTES ?? 45) * 60_000;
    const started = Date.now();
    const events: NormalisedEvent[] = [];
    const notes: string[] = [];
    let done = 0;
    let found = 0;
    for (const b of due) {
      if (Date.now() - started > budgetMs) break;
      const bbox: [number, number, number, number] = [b.minLon, b.minLat, b.maxLon, b.maxLat];
      try {
        const scan = await scanBox(bbox, ctx.now, ctx.fetchJson, ctx.log);
        const evs: NormalisedEvent[] = [];
        if (scan?.tracks.length) {
          const earlier = toRows<{ source_event_id: string; line: Array<[number, number]> | null }>(
            await db.execute(sql`
              select e.source_event_id, e.properties->'line' as line from change_events e
              where e.source_id = ${sourceId(SLUG)} and e.centroid_lon between ${bbox[0] - 0.01} and ${bbox[2] + 0.01} and e.centroid_lat between ${bbox[1] - 0.01} and ${bbox[3] + 0.01}`),
          );
          for (const t of scan.tracks) {
            const line = lineOf(scan, t);
            const mid = line[Math.floor(line.length / 2)];
            const again = earlier.find((e) => e.line?.length && sameTrack(line, e.line));
            const sourceEventId = again?.source_event_id ?? `trk-${mid[0].toFixed(4)}-${mid[1].toFixed(4)}`;
            evs.push(toEvent(scan, t, line, b.boxId, sourceEventId, ctx.now));
          }
        }
        if (ctx.emit) await ctx.emit(evs);
        else events.push(...evs);
        await db
          .update(trackBoxes)
          .set({ lastRunAt: ctx.now, tracks: evs.length, recentScenes: scan?.after.length ?? 0, clearShare: scan ? Math.round(scan.clearShare * 100) / 100 : null })
          .where(eq(trackBoxes.boxId, b.boxId));
        done++;
        found += evs.length;
        ctx.log(`${SLUG}: box ${b.boxId}: ${evs.length} new tracks${scan ? ` (${scan.after.length} recent scenes, ${Math.round(scan.clearShare * 100)}% seen clearly)` : " (too few clear scenes)"}`);
      } catch (e) {
        notes.push(`${b.boxId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (due.length > done) notes.push(`${due.length - done} of ${boxes.length} boxes left for the next run`);
    return { events, notes, extra: { boxes: boxes.length, scanned: done, tracks: found } };
  },
};
