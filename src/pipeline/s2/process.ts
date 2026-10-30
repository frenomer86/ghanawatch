import proj4 from "proj4";
import { makeGrid, readBand, withRetry, type Grid } from "./cog";
import { searchScenes, type Scene } from "./stac";
import { classify, components, composite, type Component, type Composite, type SceneBands } from "./analysis";
import { WATER_SEEN_PCT, type WaterSeen } from "../context/surface-water";

proj4.defs("EPSG:32630", "+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:32631", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs");

/** Ghana spans UTM zones 30N (west of 0°) and 31N (east of 0°). */
export const epsgFor = (lon: number) => (lon < 0 ? 32630 : 32631);
export const toProj = (epsg: number, lon: number, lat: number) => proj4("EPSG:4326", `EPSG:${epsg}`, [lon, lat]) as [number, number];
export const fromProj = (epsg: number, x: number, y: number) => proj4(`EPSG:${epsg}`, "EPSG:4326", [x, y]) as [number, number];

/** The UTM zone of a Sentinel-2 COG, from its tile path (…/sentinel-s2-l2a-cogs/30/N/XM/…). */
export function epsgFromCogUrl(url: string): number {
  const m = url.match(/sentinel-s2-l2a-cogs\/(\d{1,2})\/([NS])\//);
  if (!m) return 32630;
  return (m[2] === "N" ? 32600 : 32700) + Number(m[1]);
}

export interface CellSpec {
  id: string;
  name: string;
  bbox: [number, number, number, number]; // lon/lat
  res: number; // 20 or 40 m
  turbidity: boolean;
}

export interface CellResult {
  cell: CellSpec;
  epsg: number;
  grid: Grid;
  before: Composite;
  after: Composite;
  beforeScenes: Scene[];
  afterScenes: Scene[];
  comps: Component[];
  coverage: { before: number; after: number };
  /** Cleared or new-pond pixels dropped because water was seen there before (lake shores, floodplains). */
  waterSeenPx: number;
}

const DAY = 86_400_000;
export const WINDOW_DAYS = 120;
export const MAX_SCENES_AFTER = 7;
export const MAX_SCENES_BEFORE = 10;

function pick(scenes: Scene[], epsg: number, max: number): Scene[] {
  const same = scenes.filter((s) => s.epsg === epsg);
  const other = scenes.filter((s) => s.epsg === (epsg === 32630 ? 32631 : 32630));
  return (same.length ? same : other).sort((a, b) => a.cloud - b.cloud).slice(0, max);
}

export async function loadScene(s: Scene, grid: Grid): Promise<SceneBands> {
  const [blue, green, red, nir, swir16, scl] = await Promise.all([
    withRetry(() => readBand(s.assets.blue, grid)),
    withRetry(() => readBand(s.assets.green, grid)),
    withRetry(() => readBand(s.assets.red, grid)),
    withRetry(() => readBand(s.assets.nir, grid)),
    withRetry(() => readBand(s.assets.swir16, grid)),
    withRetry(() => readBand(s.assets.scl, grid)),
  ]);
  return { date: s.datetime.slice(0, 10), sceneId: s.id, blue, green, red, nir, swir16, scl, scale: s.scale, offset: s.offset };
}

async function loadAll(scenes: Scene[], grid: Grid, log: (m: string) => void): Promise<SceneBands[]> {
  const out: SceneBands[] = [];
  for (let i = 0; i < scenes.length; i += 3) {
    const batch = await Promise.all(
      scenes.slice(i, i + 3).map((s) =>
        loadScene(s, grid).catch((e) => {
          log(`  scene ${s.id} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
      ),
    );
    for (const b of batch) if (b) out.push(b);
  }
  // When the connection drops, most reads fail; a cell scanned from a few scenes would look clear of
  // change and be marked done. Fail it instead, so it is scanned again later.
  if (scenes.length >= 3 && out.length < scenes.length / 2) {
    throw new Error(`only ${out.length} of ${scenes.length} scenes could be read (network problem); will rescan`);
  }
  return out;
}

export async function processCell(
  cell: CellSpec,
  now: Date,
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>,
  log: (m: string) => void,
  water?: WaterSeen,
): Promise<CellResult | null> {
  const [minLon, minLat, maxLon, maxLat] = cell.bbox;
  let epsg = epsgFor((minLon + maxLon) / 2);

  // "After": clearest scenes of the last WINDOW_DAYS. "Before": clearest scenes one to two
  // years earlier, all seasons, so the baseline sees the ground despite rainy-season cloud.
  const recent = await searchScenes(fetchJson, cell.bbox, new Date(now.getTime() - WINDOW_DAYS * DAY), now);
  const older = await searchScenes(fetchJson, cell.bbox, new Date(now.getTime() - 730 * DAY), new Date(now.getTime() - 365 * DAY), 60);
  const afterScenes = pick(recent, epsg, MAX_SCENES_AFTER);
  if (afterScenes.length && afterScenes[0].epsg !== epsg) epsg = afterScenes[0].epsg;
  const beforeScenes = pick(older, epsg, MAX_SCENES_BEFORE);
  if (!afterScenes.length || !beforeScenes.length) return null;

  const corners = [toProj(epsg, minLon, minLat), toProj(epsg, maxLon, minLat), toProj(epsg, minLon, maxLat), toProj(epsg, maxLon, maxLat)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const grid = makeGrid([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], cell.res);
  const n = grid.width * grid.height;

  const after = composite(await loadAll(afterScenes, grid, log), n);
  const before = composite(await loadAll(beforeScenes, grid, log), n);
  let cb = 0;
  let ca = 0;
  for (let i = 0; i < n; i++) {
    if (before.count[i]) cb++;
    if (after.count[i] >= 2) ca++;
  }
  const cls = classify(before, after, grid, { turbidity: cell.turbidity });
  const waterSeenPx = water ? await maskWaterSeen(cls, grid, epsg, water) : 0;
  const comps = components(cls, grid);
  return { cell, epsg, grid, before, after, beforeScenes, afterScenes, comps, coverage: { before: cb / n, after: ca / n }, waterSeenPx };
}

/**
 * Drop cleared-land and new-pond pixels (classes 1 and 2) where the long-term
 * water record shows water in at least WATER_SEEN_PCT of past observations:
 * Lake Volta's shores, reservoirs and floodplains fill every rainy season, and
 * that is not a new pit. Muddy-water pixels (class 3) are kept, since rivers
 * turning brown happens exactly where water has always been.
 */
export async function maskWaterSeen(cls: Uint8Array, grid: Grid, epsg: number, water: WaterSeen): Promise<number> {
  let dropped = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== 1 && cls[i] !== 2) continue;
    const col = i % grid.width;
    const row = (i - col) / grid.width;
    const [lon, lat] = fromProj(epsg, grid.bbox[0] + (col + 0.5) * grid.res, grid.bbox[3] - (row + 0.5) * grid.res);
    if ((await water.occurrence(lon, lat)) >= WATER_SEEN_PCT) {
      cls[i] = 0;
      dropped++;
    }
  }
  return dropped;
}
