import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import proj4 from "proj4";
import { blockGrid, defineEpsg, type BlockGrid } from "./cog";
import { buildDem, buildMonth } from "./composite";
import { buildChannels, terrain } from "./features";
import { calibrate, type MiningModel } from "./model";
import { extractSites, type TsSite } from "./sites";
import { DEFAULT_PARAMS, decodeState, encodeState, monthIndex, newState, REGIME, step, type TrackerParams, type TrackerState } from "./tracker";

/**
 * One scan cell (0.2°) for one month: build the composite block by block, run the model, pool to the
 * 20 m tracker grid, advance the tracker and extract sites. The tracker state of every cell is kept on
 * disk so each month continues from the last, in the live scan and in the historical backfill alike.
 *
 * Resolution: the gold belt (priority-2 cells) at 10 m, the rest of Ghana at 20 m; the tracker always
 * runs at 20 m.
 */
type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface CellRow {
  id: string;
  regionName: string | null;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  priority: number;
}

export const STATE_RES = 20;
/**
 * Model resolution in the gold belt (priority-2 cells): 10 m by default, GW_TS_GOLD_RES=20 to run the whole
 * country at 20 m (a quarter of the compute; see docs/detector.md for the accuracy at each).
 */
export const GOLD_RES = Number(process.env.GW_TS_GOLD_RES ?? 10) === 20 ? 20 : 10;
export const BLOCK_PX = 1024;
export const DATA_DIR = process.env.GW_TS_DIR ?? join(process.cwd(), ".data", "ts");

export const epsgForLon = (lon: number) => (lon < 0 ? 32630 : 32631);

export interface CellLayout {
  epsg: number;
  res: number;
  /** The tracker grid (20 m). */
  state: BlockGrid;
  /** Model-resolution blocks covering the state grid, with their offset in state pixels. */
  blocks: Array<{ grid: BlockGrid; sx: number; sy: number }>;
}

export function cellLayout(c: CellRow): CellLayout {
  const epsg = epsgForLon((c.minLon + c.maxLon) / 2);
  const to = defineEpsg(epsg);
  const corners = [
    [c.minLon, c.minLat], [c.maxLon, c.minLat], [c.minLon, c.maxLat], [c.maxLon, c.maxLat],
  ].map((p) => proj4("EPSG:4326", to, p) as [number, number]);
  const bbox: [number, number, number, number] = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
  const state = blockGrid(epsg, bbox, STATE_RES);
  const res = c.priority >= 2 ? GOLD_RES : 20;
  const f = STATE_RES / res;
  const blockState = BLOCK_PX / f; // state pixels per block side
  const blocks: CellLayout["blocks"] = [];
  for (let sy = 0; sy < state.height; sy += blockState) {
    for (let sx = 0; sx < state.width; sx += blockState) {
      const w = Math.min(blockState, state.width - sx);
      const h = Math.min(blockState, state.height - sy);
      const x0 = state.bbox[0] + sx * STATE_RES;
      const y1 = state.bbox[3] - sy * STATE_RES;
      blocks.push({ grid: blockGrid(epsg, [x0, y1 - h * STATE_RES, x0 + w * STATE_RES, y1], res), sx, sy });
    }
  }
  return { epsg, res, state, blocks };
}

const statePath = (cellId: string) => join(DATA_DIR, "state", `${cellId}.gwts`);
const demPath = (cellId: string, i: number) => join(DATA_DIR, "dem", `${cellId}_${i}.f32`);

export function loadState(cellId: string, n: number): TrackerState {
  const p = statePath(cellId);
  if (!existsSync(p)) return newState(n);
  const raw = readFileSync(p);
  const s = decodeState(raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw);
  if (s.n !== n) throw new Error(`tracker state for ${cellId} has ${s.n} pixels, layout has ${n}`);
  return s;
}

export function saveState(cellId: string, s: TrackerState) {
  const p = statePath(cellId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, gzipSync(encodeState(s), { level: 6 }));
  renameSync(`${p}.tmp`, p); // a stopped run never leaves half a state
}

async function cachedDem(cellId: string, i: number, g: BlockGrid, fetchJson: FetchJson): Promise<Float32Array> {
  const p = demPath(cellId, i);
  if (existsSync(p)) {
    const b = readFileSync(p);
    if (b.byteLength === g.width * g.height * 4) return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  const dem = await buildDem(g, fetchJson);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(dem.buffer));
  return dem;
}

export interface CellMonthResult {
  cell: CellRow;
  month: string;
  layout: CellLayout;
  state: TrackerState;
  sites: TsSite[];
  /** Share of state pixels observed by each regime this month. */
  coverage: { sentinel2: number; landsat: number; radar: number; none: number };
  scenes: { s2: string[]; landsat: string[]; s1: string[] };
  skipped?: string;
}

/** Pool model-resolution probabilities and regimes into the 20 m state grid. Exported for tests. */
export function poolToState(prob: Float32Array, regime: Uint8Array, g: BlockGrid, f: number, out: { prob: Float32Array; regime: Uint8Array; width: number }, sx: number, sy: number) {
  const sw = Math.ceil(g.width / f);
  const sh = Math.ceil(g.height / f);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0;
      let cnt = 0;
      let best = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const yy = y * f + dy;
          const xx = x * f + dx;
          if (yy >= g.height || xx >= g.width) continue;
          const i = yy * g.width + xx;
          const r = regime[i];
          if (!r || !Number.isFinite(prob[i])) continue;
          if (!best || r < best) best = r;
          sum += prob[i];
          cnt++;
        }
      }
      const o = (sy + y) * out.width + (sx + x);
      out.prob[o] = cnt ? sum / cnt : Number.NaN;
      out.regime[o] = best;
    }
  }
}

const REGIME_NAME: Record<number, string> = { 1: "sentinel2", 2: "landsat", 3: "radar" };

/**
 * `save: false` previews a month (the one in progress): the tracker is advanced on a copy and nothing is
 * written, so the month is processed for real once it has ended.
 */
export async function processCellMonth(c: CellRow, month: string, model: MiningModel, fetchJson: FetchJson, log: (m: string) => void = () => {}, opts: { save?: boolean } = {}): Promise<CellMonthResult> {
  const layout = cellLayout(c);
  const S = layout.state;
  const n = S.width * S.height;
  const state = loadState(c.id, n);
  const mi = monthIndex(month);
  const scenes = { s2: [] as string[], landsat: [] as string[], s1: [] as string[] };
  if (state.lastMonth >= mi) {
    return { cell: c, month, layout, state, sites: extractSites(state, S.width, S.height, STATE_RES, null), coverage: { sentinel2: 0, landsat: 0, radar: 0, none: 0 }, scenes, skipped: "already processed" };
  }
  const pooled = { prob: new Float32Array(n).fill(Number.NaN), regime: new Uint8Array(n), width: S.width };
  const f = STATE_RES / layout.res;
  for (let bi = 0; bi < layout.blocks.length; bi++) {
    const { grid, sx, sy } = layout.blocks[bi];
    const bn = grid.width * grid.height;
    const dem = await cachedDem(c.id, bi, grid, fetchJson);
    const t = terrain(dem, grid.width, grid.height, grid.res);
    const comp = await buildMonth(grid, month, fetchJson, log);
    for (const k of ["s2", "landsat", "s1"] as const) for (const id of comp.scenes[k]) if (!scenes[k].includes(id)) scenes[k].push(id);
    const regime = new Uint8Array(bn);
    for (let i = 0; i < bn; i++) regime[i] = comp.s2Obs[i] ? REGIME.sentinel2 : comp.landsatObs[i] ? REGIME.landsat : comp.s1Obs[i] ? REGIME.radar : REGIME.none;
    const ch = buildChannels(comp, t, bn);
    const prob = await model.predict(ch, grid.width, grid.height);
    for (let i = 0; i < bn; i++) prob[i] = regime[i] ? calibrate(prob[i], REGIME_NAME[regime[i]], model.meta) : Number.NaN;
    poolToState(prob, regime, grid, f, pooled, sx, sy);
  }
  const before = Int16Array.from(state.onset);
  step(state, mi, pooled.prob, pooled.regime, { ...trackerParams(model) });
  const sites = extractSites(state, S.width, S.height, STATE_RES, before);
  if (opts.save !== false) saveState(c.id, state);
  const cov = { sentinel2: 0, landsat: 0, radar: 0, none: 0 };
  for (let i = 0; i < n; i++) cov[(REGIME_NAME[pooled.regime[i]] ?? "none") as keyof typeof cov]++;
  for (const k of Object.keys(cov) as (keyof typeof cov)[]) cov[k] = Math.round((cov[k] / n) * 1000) / 1000;
  return { cell: c, month, layout, state, sites, coverage: cov, scenes };
}

export function trackerParams(model: MiningModel): TrackerParams {
  return { ...DEFAULT_PARAMS, modelPrior: model.meta.baseRate ?? DEFAULT_PARAMS.modelPrior };
}
