import type { MonthComposite } from "./composite";

/**
 * Model input channels (feature set v1), in the order the mining-state model expects. The reference
 * definition is research/smallmines/features.py; tests/unit/ts-features.test.ts checks both agree.
 */
export const CHANNELS = [
  "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A", "B11", "B12",
  "NDVI", "NDWI", "MNDWI", "BSI", "NDTI", "NBR", "NDRE",
  "VV", "VH", "VH_VV",
  "SLOPE", "REL_ELEV",
  "OPT_OK", "RE_OK",
] as const;
export const N_CH = CHANNELS.length;
export const OPTICAL = Array.from({ length: 17 }, (_, i) => i);
export const RED_EDGE = [3, 4, 5, 16];
export const RADAR = [17, 18, 19];
export const REL_ELEV_RADIUS = 15;
const EPS = 1e-6;

const nd = (a: number, b: number) => (a - b) / (a + b + EPS);

/** Mean over a (2r+1)^2 window with edge replication (integral image), as in features.py. */
export function boxMean(x: Float32Array, w: number, h: number, r: number): Float32Array {
  const pw = w + 2 * r;
  const ph = h + 2 * r;
  const ii = new Float64Array((pw + 1) * (ph + 1));
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - r));
    let row = 0;
    for (let xx = 0; xx < pw; xx++) {
      const sx = Math.min(w - 1, Math.max(0, xx - r));
      row += x[sy * w + sx];
      ii[(y + 1) * (pw + 1) + (xx + 1)] = ii[y * (pw + 1) + (xx + 1)] + row;
    }
  }
  const k = 2 * r + 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < w; xx++) {
      const a = ii[(y + k) * (pw + 1) + (xx + k)];
      const b = ii[y * (pw + 1) + (xx + k)];
      const c = ii[(y + k) * (pw + 1) + xx];
      const d = ii[y * (pw + 1) + xx];
      out[y * w + xx] = (a - b - c + d) / (k * k);
    }
  }
  return out;
}

/** Slope in degrees from central differences with edge replication, as in features.py. */
export function slopeDeg(dem: Float32Array, w: number, h: number, res: number): Float32Array {
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => dem[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * res);
      const dzdy = (at(x, y + 1) - at(x, y - 1)) / (2 * res);
      out[y * w + x] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return out;
}

export interface Terrain {
  slope: Float32Array;
  relElev: Float32Array;
}

export function terrain(dem: Float32Array, w: number, h: number, res: number): Terrain {
  const mean = boxMean(dem, w, h, REL_ELEV_RADIUS);
  const relElev = new Float32Array(w * h);
  for (let i = 0; i < relElev.length; i++) relElev[i] = dem[i] - mean[i];
  return { slope: slopeDeg(dem, w, h, res), relElev };
}

/** Channels (N_CH planes of w*h) before normalisation; 0 where a value is undefined. */
export function buildChannels(c: Pick<MonthComposite, "refl" | "optOk" | "reOk" | "vv" | "vh">, t: Terrain, n: number): Float32Array[] {
  const ch = Array.from({ length: N_CH }, () => new Float32Array(n));
  const r = c.refl;
  for (let i = 0; i < n; i++) {
    if (c.optOk[i]) {
      for (let b = 0; b < 10; b++) ch[b][i] = r[b][i];
      const B2 = r[0][i], B3 = r[1][i], B4 = r[2][i], B5 = r[3][i], B8 = r[6][i], B8A = r[7][i], B11 = r[8][i], B12 = r[9][i];
      ch[10][i] = nd(B8, B4);
      ch[11][i] = nd(B3, B8);
      ch[12][i] = nd(B3, B11);
      ch[13][i] = (B11 + B4 - (B8 + B2)) / (B11 + B4 + (B8 + B2) + EPS);
      ch[14][i] = nd(B4, B3);
      ch[15][i] = nd(B8, B12);
      ch[16][i] = c.reOk[i] ? nd(B8A, B5) : 0;
      if (!c.reOk[i]) ch[3][i] = ch[4][i] = ch[5][i] = 0;
    }
    const vv = c.vv[i];
    const vh = c.vh[i];
    if (Number.isFinite(vv) && Number.isFinite(vh)) {
      ch[17][i] = vv;
      ch[18][i] = vh;
      ch[19][i] = vh - vv;
    }
    ch[20][i] = t.slope[i];
    ch[21][i] = t.relElev[i];
    ch[22][i] = c.optOk[i];
    ch[23][i] = c.reOk[i];
    for (let k = 0; k < N_CH; k++) if (!Number.isFinite(ch[k][i])) ch[k][i] = 0;
  }
  return ch;
}

export interface Norm {
  mean: number[];
  std: number[];
}

/** Standardise in place; unobserved optical / red-edge / radar values become 0 (the training mean). */
export function normalise(ch: Float32Array[], norm: Norm): void {
  const n = ch[0].length;
  const opt = ch[22];
  const re = ch[23];
  const radOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) radOk[i] = ch[17][i] !== 0 ? 1 : 0;
  for (let k = 0; k < N_CH; k++) {
    if (k === 22 || k === 23) continue;
    const m = norm.mean[k];
    const s = norm.std[k];
    const isOpt = k < 17;
    const isRe = RED_EDGE.includes(k);
    const isRad = RADAR.includes(k);
    const p = ch[k];
    for (let i = 0; i < n; i++) {
      if ((isOpt && opt[i] < 0.5) || (isRe && re[i] < 0.5) || (isRad && !radOk[i])) p[i] = 0;
      else p[i] = (p[i] - m) / s;
    }
  }
}
