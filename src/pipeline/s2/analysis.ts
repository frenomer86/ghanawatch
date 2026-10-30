import type { Grid } from "./cog";

/**
 * Pixel-level change analysis for galamsey signatures.
 *
 * Per scene, valid pixels are those the Sentinel-2 scene classification (SCL)
 * marks as vegetation (4), bare soil (5) or water (6), and that are not bright
 * in blue (residual haze). Per period, the per-pixel median of each index over
 * valid observations forms the composite.
 *
 * Indices: NDVI (vegetation), BSI (bare soil), NDWI (open water), NDTI
 * (turbidity, red vs green over water).
 */
export const VALID_SCL = new Set([4, 5, 6]);
/** Blue reflectance above this is treated as residual cloud or haze. */
export const HAZE_BLUE = 0.12;
/**
 * A cloud shadow the scene classification missed is dark in every band, so it reads as water or
 * bare ground by its ratios alone. Open pit water (silty) and exposed soil are not that dark.
 * Measured on the October 2026 accuracy sample: these two guards removed all four shadow false
 * alarms and kept every real pit checked.
 */
export const MIN_WATER_GREEN = 0.035;
export const MIN_BARE_SWIR = 0.12;

type Band = Uint16Array | Uint8Array;

export interface SceneBands {
  date: string;
  sceneId: string;
  blue: Band;
  green: Band;
  red: Band;
  nir: Band;
  swir16: Band;
  scl: Band;
  scale: number;
  offset: number;
}

export interface Composite {
  ndvi: Float32Array;
  bsi: Float32Array;
  ndwi: Float32Array;
  ndti: Float32Array;
  count: Uint8Array;
  /** Observations in which the pixel looked bare or wet (vegetation gone): a change must persist, not just sway the median. */
  lostObs: Uint8Array;
  /** Observations in which the pixel looked like open water. */
  waterObs: Uint8Array;
  /** Scene index of the most recent valid observation per pixel. */
  lastIdx: Int8Array;
  /** Per scene, 1 where that scene had a clear view of the pixel. */
  valid: Uint8Array[];
  dates: string[];
  sceneIds: string[];
}

export function composite(scenes: SceneBands[], n: number): Composite {
  const K = Math.max(1, scenes.length);
  const v = { ndvi: new Float32Array(n * K), bsi: new Float32Array(n * K), ndwi: new Float32Array(n * K), ndti: new Float32Array(n * K) };
  const count = new Uint8Array(n);
  const lostObs = new Uint8Array(n);
  const waterObs = new Uint8Array(n);
  const lastIdx = new Int8Array(n).fill(-1);
  const order = scenes.map((_, i) => i).sort((a, b) => scenes[b].date.localeCompare(scenes[a].date));
  const valid = scenes.map(() => new Uint8Array(n));
  // Neighbouring Sentinel-2 tiles overlap, so one pass can reach a pixel twice; it counts once,
  // otherwise a single pass (with its cloud shadows) would look like two agreeing observations.
  const dateIndex = new Map([...new Set(order.map((k) => scenes[k].date))].map((d, j) => [d, j]));
  const seenDate = new Int16Array(n).fill(-1);
  for (const k of order) {
    const s = scenes[k];
    const vk = valid[k];
    const dk = dateIndex.get(s.date)!;
    for (let i = 0; i < n; i++) {
      if (seenDate[i] === dk) continue;
      if (!VALID_SCL.has(s.scl[i]) || !s.red[i] || !s.nir[i]) continue;
      const B = s.blue[i] * s.scale + s.offset;
      if (B > HAZE_BLUE) continue;
      seenDate[i] = dk;
      const G = s.green[i] * s.scale + s.offset;
      const R = s.red[i] * s.scale + s.offset;
      const N = s.nir[i] * s.scale + s.offset;
      const S = s.swir16[i] * s.scale + s.offset;
      const o = i * K + count[i];
      v.ndvi[o] = (N - R) / (N + R + 1e-6);
      v.bsi[o] = (S + R - (N + B)) / (S + R + N + B + 1e-6);
      v.ndwi[o] = (G - N) / (G + N + 1e-6);
      v.ndti[o] = (R - G) / (R + G + 1e-6);
      // One cloud shadow or hazy pass can drag a two-pass median past the thresholds; count the passes that agree.
      const t = THRESHOLDS;
      const wet = v.ndwi[o] >= t.pondAfter && G >= MIN_WATER_GREEN;
      const bare = v.bsi[o] >= t.bareAfter && S >= MIN_BARE_SWIR;
      if (v.ndvi[o] <= t.vegAfter && (bare || wet)) lostObs[i]++;
      if (v.ndvi[o] <= t.vegAfter && wet) waterObs[i]++;
      count[i]++;
      vk[i] = 1;
      if (lastIdx[i] < 0) lastIdx[i] = k;
    }
  }
  const buf: number[] = [];
  const med = (arr: Float32Array) => {
    const out = new Float32Array(n).fill(Number.NaN);
    for (let i = 0; i < n; i++) {
      const c = count[i];
      if (!c) continue;
      buf.length = 0;
      for (let j = 0; j < c; j++) buf.push(arr[i * K + j]);
      buf.sort((a, b) => a - b);
      out[i] = c % 2 ? buf[(c - 1) / 2] : (buf[c / 2 - 1] + buf[c / 2]) / 2;
    }
    return out;
  };
  return {
    ndvi: med(v.ndvi),
    bsi: med(v.bsi),
    ndwi: med(v.ndwi),
    ndti: med(v.ndti),
    count,
    lostObs,
    waterObs,
    lastIdx,
    valid,
    dates: scenes.map((s) => s.date),
    sceneIds: scenes.map((s) => s.sceneId),
  };
}

export const THRESHOLDS = {
  vegBefore: 0.55, // clearly vegetated in the baseline
  vegAfter: 0.3, // vegetation largely gone now
  bareAfter: 0.0, // bare-soil index positive: exposed ground
  pondAfter: 0.05, // open water now
  pondBefore: -0.1, // and not water in the baseline
  baselineWater: 0.0, // baseline pixels at or above this NDWI count as existing water
  waterBufferM: 60, // new water this close to existing water is treated as flooding, not new pits
  turbidWater: 0.1,
  turbidNdti: 0.05,
  turbidRise: 0.08,
  turbidMaxFromBankM: 150, // muddy water farther than this from the baseline bank is a lake or reservoir, not a river
  minDisturbHa: 0.48,
  minPondOnlyHa: 0.32, // pit clusters in farms or settlements can be smaller than forest clearings
  minTurbidHa: 1,
  // A change must be seen on this many clear recent observations, each showing it. S2_MIN_AFTER_OBS=1 is the
  // relaxed rule tested on 18 Oct 2026 (more sites found in cloudy areas); it is off unless set.
  minAfterObs: Number(process.env.S2_MIN_AFTER_OBS ?? 2) === 1 ? 1 : 2,
};

/**
 * Pixel classes:
 * 1 vegetation cleared to bare soil
 * 2 new pond: water now, not water in the baseline, away from existing water, on any land
 *   (forest, farm, settlement or open ground)
 * 3 existing water that turned turbid (only when turbidity is enabled for the cell)
 */
export function classify(before: Composite, after: Composite, grid: Grid, opts: { turbidity: boolean }): Uint8Array {
  const t = THRESHOLDS;
  const W = grid.width;
  const H = grid.height;
  const n = W * H;

  // Existing water in the baseline, dilated by waterBufferM, so river and reservoir edges
  // swelling in the rainy season are not mistaken for new pits.
  const water = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (before.count[i] && before.ndwi[i] >= t.baselineWater) water[i] = 1;
  const r = Math.max(1, Math.round(t.waterBufferM / grid.res));
  const nearWater = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!water[y * W + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) nearWater[yy * W + xx] = 1;
        }
      }
    }
  }

  const rb = Math.max(1, Math.round(t.turbidMaxFromBankM / grid.res));
  const nearBank = (i: number) => {
    const x = i % W;
    const y = (i - x) / W;
    for (let dy = -rb; dy <= rb; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -rb; dx <= rb; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const j = yy * W + xx;
        if (before.count[j] && !water[j]) return true;
      }
    }
    return false;
  };

  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!before.count[i] || after.count[i] < t.minAfterObs) continue;
    const vb = before.ndvi[i];
    const va = after.ndvi[i];
    const wb = before.ndwi[i];
    const wa = after.ndwi[i];
    // Shadowed forest stays green (NDVI high); real new water does not.
    if (wa >= t.pondAfter && wb <= t.pondBefore && va <= t.vegAfter && !nearWater[i] && after.waterObs[i] >= t.minAfterObs) {
      cls[i] = 2;
      continue;
    }
    if (vb >= t.vegBefore && va <= t.vegAfter && after.bsi[i] >= t.bareAfter && after.lostObs[i] >= t.minAfterObs) {
      cls[i] = 1;
      continue;
    }
    // A river that turned muddy: water in the baseline too (newly flooded land is not a river), turbidity
    // risen, and close to the bank (open water far from any bank is Lake Volta or a reservoir).
    if (opts.turbidity && wb >= t.turbidWater && wa >= t.turbidWater && after.ndti[i] >= t.turbidNdti && after.ndti[i] - before.ndti[i] >= t.turbidRise) {
      if (nearBank(i)) cls[i] = 3;
    }
  }
  return cls;
}

export interface Component {
  kind: "disturbance" | "turbid";
  pixels: number[];
  ponds: number;
  cleared: number;
}

/** 8-connected components; classes 1 and 2 group as disturbance, class 3 as turbid water. */
export function components(cls: Uint8Array, grid: Grid): Component[] {
  const W = grid.width;
  const H = grid.height;
  const pxHa = (grid.res * grid.res) / 10_000;
  const seen = new Uint8Array(W * H);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!cls[start] || seen[start]) continue;
    const turbid = cls[start] === 3;
    const comp: Component = { kind: turbid ? "turbid" : "disturbance", pixels: [], ponds: 0, cleared: 0 };
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.pixels.push(p);
      if (cls[p] === 2) comp.ponds++;
      if (cls[p] === 1) comp.cleared++;
      const x = p % W;
      const y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (seen[q] || !cls[q] || (cls[q] === 3) !== turbid) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    const ha = comp.pixels.length * pxHa;
    const minHa = turbid ? THRESHOLDS.minTurbidHa : comp.cleared === 0 ? THRESHOLDS.minPondOnlyHa : THRESHOLDS.minDisturbHa;
    if (ha >= minHa) out.push(comp);
  }
  return out;
}

/** Convex hull (monotone chain) of the component's pixel corners, in projected metres. */
export function hullMetres(comp: Component, grid: Grid): [number, number][] {
  const W = grid.width;
  const r = grid.res;
  const pts: [number, number][] = [];
  for (const p of comp.pixels) {
    const x = p % W;
    const y = (p - x) / W;
    const mx = grid.bbox[0] + x * r;
    const my = grid.bbox[3] - y * r;
    pts.push([mx, my], [mx + r, my], [mx, my - r], [mx + r, my - r]);
  }
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
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  hull.push(hull[0]);
  return hull;
}
