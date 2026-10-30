import { makeGrid, type Grid } from "@/pipeline/s2/cog";
import { fromProj, toProj } from "@/pipeline/s2/process";
import { readRadarDb, type RadarScene } from "./pc";
import { WATER_SEEN_PCT, type WaterSeen } from "../context/surface-water";

/**
 * New open water seen by radar, for places the optical scan cannot see in the
 * rains. Per pixel, the median backscatter of the recent passes is compared
 * with the median of the same weeks two years earlier: water is dark to radar
 * (below about -18 dB), so pixels that turned dark where they were not before,
 * away from water that was already there, are new ponds. Mining pits fill with
 * water this way; new fish ponds or flooded fields can look the same.
 */
export const WATER_RULES = { nowDb: -18, beforeDb: -12, dropDb: 7, baselineWaterDb: -15, bufferPx: 3, minPx: 13 };
const RES = 20;

export interface RadarPond {
  pixels: number[];
  areaHa: number;
  centre: { lon: number; lat: number };
  ring: [number, number][];
}

function median(stack: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n).fill(Number.NaN);
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (const s of stack) if (Number.isFinite(s[i])) buf.push(s[i]);
    if (buf.length < 2) continue;
    buf.sort((a, b) => a - b);
    const m = buf.length >> 1;
    out[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
  }
  return out;
}

/** Classify new-water pixels from the two medians; exported for tests. */
export function newWaterMask(now: Float32Array, before: Float32Array, grid: Pick<Grid, "width" | "height">): Uint8Array {
  const W = grid.width;
  const H = grid.height;
  const n = W * H;
  const r = WATER_RULES;
  const nearOld = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!(before[y * W + x] < r.baselineWaterDb)) continue;
      for (let dy = -r.bufferPx; dy <= r.bufferPx; dy++) {
        for (let dx = -r.bufferPx; dx <= r.bufferPx; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W) nearOld[yy * W + xx] = 1;
        }
      }
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (nearOld[i]) continue;
    if (now[i] < r.nowDb && before[i] > r.beforeDb && before[i] - now[i] >= r.dropDb) out[i] = 1;
  }
  return out;
}

export async function radarPonds(
  cellBbox: [number, number, number, number],
  epsg: number,
  recent: RadarScene[],
  baseline: RadarScene[],
  sas: string,
  water?: WaterSeen,
): Promise<{ ponds: RadarPond[]; grid: Grid; coverage: number }> {
  const [minLon, minLat, maxLon, maxLat] = cellBbox;
  const corners = [toProj(epsg, minLon, minLat), toProj(epsg, maxLon, minLat), toProj(epsg, minLon, maxLat), toProj(epsg, maxLon, maxLat)];
  const grid = makeGrid(
    [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
    RES,
  );
  const n = grid.width * grid.height;
  const read = (scenes: RadarScene[]) => Promise.all(scenes.map((s) => readRadarDb(s.vv, sas, grid).catch(() => null)));
  const nowStack = (await read(recent)).filter((x): x is Float32Array => x !== null);
  const beforeStack = (await read(baseline)).filter((x): x is Float32Array => x !== null);
  const now = median(nowStack, n);
  const before = median(beforeStack, n);
  let both = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(now[i]) && Number.isFinite(before[i])) both++;
  const mask = newWaterMask(now, before, grid);
  // Lake shores and floodplains that the long-term record shows as water fill every rainy season.
  if (water) {
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      const [lon, lat] = fromProj(epsg, grid.bbox[0] + (x + 0.5) * RES, grid.bbox[3] - (y + 0.5) * RES);
      if ((await water.occurrence(lon, lat)) >= WATER_SEEN_PCT) mask[i] = 0;
    }
  }

  // 8-connected patches of new water, at least WATER_RULES.minPx pixels (about half a hectare).
  const W = grid.width;
  const seen = new Uint8Array(n);
  const ponds: RadarPond[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % W;
      const y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= grid.height) continue;
          const q = yy * W + xx;
          if (seen[q] || !mask[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (pixels.length < WATER_RULES.minPx) continue;
    let sx = 0;
    let sy = 0;
    const pts: [number, number][] = [];
    for (const p of pixels) {
      const x = p % W;
      const y = (p - x) / W;
      const mx = grid.bbox[0] + (x + 0.5) * RES;
      const my = grid.bbox[3] - (y + 0.5) * RES;
      sx += mx;
      sy += my;
      pts.push([mx - RES / 2, my + RES / 2], [mx + RES / 2, my + RES / 2], [mx - RES / 2, my - RES / 2], [mx + RES / 2, my - RES / 2]);
    }
    const [lon, lat] = fromProj(epsg, sx / pixels.length, sy / pixels.length);
    ponds.push({ pixels, areaHa: (pixels.length * RES * RES) / 10_000, centre: { lon, lat }, ring: hull(pts).map(([x, y]) => fromProj(epsg, x, y)) });
  }
  return { ponds, grid, coverage: n ? both / n : 0 };
}

/** Convex hull (monotone chain), closed. */
export function hull(pts: [number, number][]): [number, number][] {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  h.push(h[0]);
  return h;
}
