import type { SceneBands } from "../s2/analysis";
import { HAZE_BLUE, MIN_BARE_SWIR, MIN_WATER_GREEN, THRESHOLDS, VALID_SCL } from "../s2/analysis";
import { edgeShare, isRoadShape, patchShape, ROAD_MAX_EDGE_SHARE, thinParts } from "./shape";

const WET_NDWI = THRESHOLDS.pondAfter;

/**
 * New tracks into forest from Sentinel-2 at 10 m (pure; exported for tests).
 *
 * A track 5 to 15 m wide is a pixel or two across at 10 m, so it rarely reads as fully bare: the pixel mixes
 * laterite with the canopy at the verge. The rule is therefore a fall in greenness that persists, on ground
 * that was closed forest before:
 *   forest before   median NDVI of the baseline (one to two years earlier) at least FOREST_NDVI;
 *   opened now      median NDVI of the last months at most OPEN_NDVI and at least DROP below the baseline,
 *                   with soil showing (shortwave infrared at least MIN_BARE_SWIR, bare-soil index at least
 *                   OPEN_BSI) in at least MIN_OPEN_OBS separate clear observations and in at least half of
 *                   them (a cloud edge or shadow the scene mask missed opens a pixel once, not every time),
 *                   and not water.
 * The bodies of new clearings are set aside (a track usually ends at one; see thinParts), the remaining opened
 * pixels are grouped (pixels up to one pixel apart join, so a track broken by a tree crown stays one), and a group shaped like a track and lying against standing forest (src/pipeline/tracks/shape.ts) is
 * kept. Ground open before (baseline NDVI below OPEN_BEFORE_NDVI) is what an old clearing's edge touches. A
 * line of new pits dug up a stream is long and thin too; it holds water, so a strip with water seen beside it
 * is left to the pit detectors.
 */
export const TRACK_RULES = {
  FOREST_NDVI: 0.6,
  OPEN_NDVI: 0.5,
  DROP: 0.2,
  OPEN_BSI: -0.05,
  MIN_OPEN_OBS: 2,
  OPEN_BEFORE_NDVI: 0.5,
  MIN_PIXELS: 15,
  /** A strip with more than this share of its pixels within two pixels of water seen recently is a line of pits along a stream. */
  MAX_WET_SHARE: 0.15,
} as const;

export interface TrackComposite {
  ndvi: Float32Array;
  ndwi: Float32Array;
  count: Uint8Array;
  /** Clear observations in which the pixel showed soil and lost greenness. */
  opened: Uint8Array;
  /** Clear observations in which the pixel showed open water. */
  wet: Uint8Array;
}

/**
 * Median NDVI and NDWI per pixel over clear observations, and how often the ground showed open. Scenes are
 * added one at a time so their bands can be dropped as soon as they are counted (a 0.1-degree box at 10 m is
 * 1.2 million pixels per band).
 */
export class TrackAccumulator {
  private readonly nd: Float32Array;
  private readonly nw: Float32Array;
  readonly count: Uint8Array;
  readonly opened: Uint8Array;
  readonly wet: Uint8Array;
  private readonly lastDay: Int16Array;
  private readonly days = new Map<string, number>();

  constructor(
    readonly n: number,
    private readonly maxObs: number,
  ) {
    this.nd = new Float32Array(n * maxObs);
    this.nw = new Float32Array(n * maxObs);
    this.count = new Uint8Array(n);
    this.opened = new Uint8Array(n);
    this.wet = new Uint8Array(n);
    this.lastDay = new Int16Array(n).fill(-1);
  }

  add(s: SceneBands) {
    const K = this.maxObs;
    // Two tiles or processing runs of the same day are one observation of a pixel.
    let dj = this.days.get(s.date);
    if (dj == null) {
      dj = this.days.size;
      this.days.set(s.date, dj);
    }
    const { nd, nw, count, opened, wet, lastDay } = this;
    for (let i = 0; i < this.n; i++) {
      if (lastDay[i] === dj || count[i] >= K) continue;
      if (!VALID_SCL.has(s.scl[i]) || !s.red[i] || !s.nir[i]) continue;
      const B = s.blue[i] * s.scale + s.offset;
      if (B > HAZE_BLUE) continue;
      lastDay[i] = dj;
      const G = s.green[i] * s.scale + s.offset;
      const R = s.red[i] * s.scale + s.offset;
      const N = s.nir[i] * s.scale + s.offset;
      const S = s.swir16[i] * s.scale + s.offset;
      const ndvi = (N - R) / (N + R + 1e-6);
      const bsi = (S + R - (N + B)) / (S + R + N + B + 1e-6);
      const o = i * K + count[i];
      nd[o] = ndvi;
      nw[o] = (G - N) / (G + N + 1e-6);
      if (nw[o] >= WET_NDWI && G >= MIN_WATER_GREEN) wet[i]++;
      if (ndvi <= TRACK_RULES.OPEN_NDVI && S >= MIN_BARE_SWIR && bsi >= TRACK_RULES.OPEN_BSI) opened[i]++;
      count[i]++;
    }
  }

  finish(): TrackComposite {
    const { n, count } = this;
    const K = this.maxObs;
    const med = (arr: Float32Array) => {
      const out = new Float32Array(n).fill(Number.NaN);
      const buf: number[] = [];
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
    return { ndvi: med(this.nd), ndwi: med(this.nw), count, opened: this.opened, wet: this.wet };
  }
}

export function trackComposite(scenes: SceneBands[], n: number): TrackComposite {
  const acc = new TrackAccumulator(n, Math.max(1, scenes.length));
  for (const s of scenes) acc.add(s);
  return acc.finish();
}

/** 1 where closed forest has newly opened. */
export function openedMask(before: TrackComposite, after: TrackComposite): Uint8Array {
  const R = TRACK_RULES;
  const n = before.ndvi.length;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!before.count[i] || !after.count[i]) continue;
    const vb = before.ndvi[i];
    const va = after.ndvi[i];
    const persistent = after.opened[i] >= R.MIN_OPEN_OBS && after.opened[i] * 2 >= after.count[i];
    if (vb >= R.FOREST_NDVI && va <= R.OPEN_NDVI && vb - va >= R.DROP && persistent && !(after.ndwi[i] >= 0)) m[i] = 1;
  }
  return m;
}

export interface TrackFound {
  /** Centre line in grid pixel coordinates (column, row), pixel centres at +0.5. */
  line: Array<[number, number]>;
  lengthM: number;
  widthM: number;
  pixels: number;
  /** Share of its pixels within two pixels of ground open before. */
  edge: number;
  /** Mean number of clear observations in which its pixels showed open. */
  openObs: number;
  /** Its pixels, as indices into the grid. */
  cells: number[];
}

/** Tracks among the newly opened pixels of a width × height grid of `res` metres. */
export function findTracks(opened: Uint8Array, before: TrackComposite, after: TrackComposite, width: number, height: number, res: number): TrackFound[] {
  const mask = thinParts(opened, width, height);
  const seen = new Uint8Array(mask.length);
  const out: TrackFound[] = [];
  const stack: number[] = [];
  const openBefore = (i: number) => before.count[i] > 0 && before.ndvi[i] < TRACK_RULES.OPEN_BEFORE_NDVI;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    const cols: number[] = [];
    const rows: number[] = [];
    const cells: number[] = [];
    let obs = 0;
    while (stack.length) {
      const p = stack.pop()!;
      cells.push(p);
      const c = p % width;
      const r = (p - c) / width;
      cols.push(c);
      rows.push(r);
      obs += after.opened[p];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cc = c + dx;
          const rr = r + dy;
          if (cc < 0 || rr < 0 || cc >= width || rr >= height) continue;
          const q = rr * width + cc;
          if (!mask[q] || seen[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (cols.length < TRACK_RULES.MIN_PIXELS) continue;
    const sh = patchShape(cols, rows);
    const lengthM = sh.lengthPx * res;
    const widthM = sh.widthPx * res;
    if (!isRoadShape(lengthM, widthM)) continue;
    const edge = edgeShare(openBefore, width, height, cols, rows);
    if (edge > ROAD_MAX_EDGE_SHARE) continue;
    if (edgeShare((i) => after.wet[i] > 0, width, height, cols, rows) > TRACK_RULES.MAX_WET_SHARE) continue;
    out.push({ line: sh.line, lengthM: Math.round(lengthM), widthM: Math.round(widthM), pixels: cols.length, edge: Math.round(edge * 100) / 100, openObs: Math.round((obs / cols.length) * 10) / 10, cells });
  }
  return out;
}
