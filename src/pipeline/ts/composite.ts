import { searchRadar } from "../s1/pc";
import { pcToken, searchDem, searchLandsat, searchS2, type LandsatScene, type S2Scene } from "./catalog";
import { gridLonLatBbox, readToGrid, type BlockGrid } from "./cog";

/**
 * Monthly multi-sensor composite for one block: the input of the mining-state model.
 *
 * Sentinel-2: every L2A scene of the month (up to MAX_S2_SCENES, clearest first), all ten 10 m and 20 m
 * bands. A pixel observation is kept when the scene classification calls it vegetation, bare ground or
 * water and its blue reflectance is below the haze limit. A second pass drops observations that stand
 * out from the pixel's own month (haze or thin cloud: blue well above the month's median; unflagged
 * cloud shadow: NIR and SWIR far below it), then each band's median is taken. Overlapping tiles of the
 * same pass count once.
 *
 * Landsat 8/9: where Sentinel-2 had no clear view all month, Landsat surface reflectance fills the six
 * bands both sensors share, cross-calibrated to Sentinel-2 with the HLS bandpass adjustment
 * (Claverie et al., 2018). Red-edge bands stay empty there and the model is told so (RE_OK = 0).
 *
 * Sentinel-1: the median VV and VH backscatter (dB) of every pass in the month, so a cloud-bound month
 * still has radar.
 */
type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export const MAX_S2_SCENES = 12;
export const MAX_LANDSAT_SCENES = 6;
export const MAX_S1_SCENES = 10;
/** Scene classification classes kept: 4 vegetation, 5 bare soil, 6 water. */
export const VALID_SCL = new Set([4, 5, 6]);
export const HAZE_BLUE = 0.12;
/** Second pass: blue this far above the pixel's monthly median is haze or thin cloud. */
export const HAZE_RISE = 0.04;
/** Second pass: NIR and SWIR both below this share of the monthly median is an unflagged cloud shadow. */
export const SHADOW_DROP = 0.6;
/**
 * HLS v2 bandpass adjustment, Sentinel-2 MSI to Landsat 8 OLI: OLI = slope * MSI + offset (Claverie et al.,
 * 2018, Table 7). GhanaWatch inverts it to put Landsat on the Sentinel-2 scale. Bands: blue, green, red,
 * NIR (MSI B8A), SWIR1, SWIR2.
 */
export const HLS_MSI_TO_OLI = [
  { slope: 0.9778, offset: -0.004 },
  { slope: 1.0053, offset: -0.0009 },
  { slope: 0.9765, offset: 0.0009 },
  { slope: 0.9983, offset: -0.0001 },
  { slope: 0.9987, offset: -0.0011 },
  { slope: 1.003, offset: -0.0012 },
];
/** Where each Landsat band goes among the ten Sentinel-2 bands (B02 B03 B04 B05 B06 B07 B08 B8A B11 B12). */
const LANDSAT_TO_S2 = [0, 1, 2, 7, 8, 9];

export interface MonthComposite {
  month: string;
  grid: BlockGrid;
  /** Ten bands, reflectance, NaN where the month had no clear optical view. */
  refl: Float32Array[];
  optOk: Uint8Array;
  reOk: Uint8Array;
  s2Obs: Uint8Array;
  landsatObs: Uint8Array;
  vv: Float32Array;
  vh: Float32Array;
  s1Obs: Uint8Array;
  scenes: { s2: string[]; landsat: string[]; s1: string[] };
}

export function monthRange(month: string): [Date, Date] {
  const [y, m] = month.split("-").map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
}

export function median(buf: number[]): number {
  if (!buf.length) return Number.NaN;
  buf.sort((a, b) => a - b);
  const h = buf.length >> 1;
  return buf.length % 2 ? buf[h] : (buf[h - 1] + buf[h]) / 2;
}

interface Obs {
  date: string;
  bands: Float32Array[]; // reflectance
  ok: Uint8Array;
}

/** Combine per-scene observations into per-band medians with the two-pass screen. Exported for tests. */
export function compositeObservations(obs: Obs[], n: number, nb: number): { refl: Float32Array[]; count: Uint8Array } {
  // One pass of the satellite counts once where neighbouring tiles overlap.
  const byDate = new Map<string, number>();
  const dateOf = obs.map((o) => {
    if (!byDate.has(o.date)) byDate.set(o.date, byDate.size);
    return byDate.get(o.date)!;
  });
  const use = obs.map((o) => new Uint8Array(o.ok));
  const seen = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    seen.fill(0, 0, 0);
  }
  const lastDate = new Int32Array(n).fill(-1);
  for (let k = 0; k < obs.length; k++) {
    const u = use[k];
    for (let i = 0; i < n; i++) {
      if (!u[i]) continue;
      if (lastDate[i] === dateOf[k]) u[i] = 0;
      else lastDate[i] = dateOf[k];
    }
  }
  const BLUE = 0, NIR = 6, SWIR1 = 8;
  const refl = Array.from({ length: nb }, () => new Float32Array(n).fill(Number.NaN));
  const count = new Uint8Array(n);
  const buf: number[] = [];
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    keep.length = 0;
    for (let k = 0; k < obs.length; k++) if (use[k][i]) keep.push(k);
    if (!keep.length) continue;
    if (keep.length >= 3) {
      buf.length = 0;
      for (const k of keep) buf.push(obs[k].bands[BLUE][i]);
      const mB = median(buf);
      buf.length = 0;
      for (const k of keep) buf.push(obs[k].bands[NIR][i]);
      const mN = median(buf);
      buf.length = 0;
      for (const k of keep) buf.push(obs[k].bands[SWIR1][i]);
      const mS = median(buf);
      const screened = keep.filter((k) => {
        const b = obs[k].bands;
        if (b[BLUE][i] > mB + HAZE_RISE) return false;
        if (b[NIR][i] < SHADOW_DROP * mN && b[SWIR1][i] < SHADOW_DROP * mS) return false;
        return true;
      });
      if (screened.length) {
        keep.length = 0;
        keep.push(...screened);
      }
    }
    count[i] = Math.min(255, keep.length);
    for (let b = 0; b < nb; b++) {
      buf.length = 0;
      for (const k of keep) buf.push(obs[k].bands[b][i]);
      refl[b][i] = median(buf);
    }
  }
  return { refl, count };
}

async function readS2Scene(s: S2Scene, g: BlockGrid): Promise<Obs | null> {
  const scl = await readToGrid(s.scl, g, { epsg: s.epsg, nodata: 0, fill: 0 });
  const n = g.width * g.height;
  const ok = new Uint8Array(n);
  let any = 0;
  for (let i = 0; i < n; i++) if (VALID_SCL.has(scl[i])) (ok[i] = 1), any++;
  if (any < n * 0.005) return null;
  const raw = await Promise.all(s.hrefs.map((h) => readToGrid(h, g, { epsg: s.epsg, nodata: 0 })));
  const bands = raw.map((r, b) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = r[i] * s.scale[b] + s.offset[b];
    return out;
  });
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    if (!Number.isFinite(bands[0][i]) || !Number.isFinite(bands[2][i]) || !Number.isFinite(bands[6][i]) || bands[0][i] > HAZE_BLUE || bands[6][i] <= 0) ok[i] = 0;
  }
  return { date: s.datetime.slice(0, 10), bands, ok };
}

/** Landsat QA_PIXEL: keep clear or water, drop fill, dilated cloud, cirrus, cloud and cloud shadow. */
export function landsatClear(qa: number): boolean {
  if (!Number.isFinite(qa)) return false;
  const q = qa | 0;
  if (q & 0b11111) return false; // bits 0-4: fill, dilated cloud, cirrus, cloud, shadow
  return (q & (1 << 6)) !== 0 || (q & (1 << 7)) !== 0;
}

async function readLandsatScene(s: LandsatScene, g: BlockGrid, token: string, need: Uint8Array): Promise<Obs | null> {
  const qa = await readToGrid(s.qa, g, { epsg: s.epsg, token, nodata: 1, fill: 1 });
  const n = g.width * g.height;
  const ok = new Uint8Array(n);
  let any = 0;
  for (let i = 0; i < n; i++) if (need[i] && landsatClear(qa[i])) (ok[i] = 1), any++;
  if (!any) return null;
  const raw = await Promise.all(s.hrefs.map((h) => readToGrid(h, g, { epsg: s.epsg, token, nodata: 0 })));
  const bands = Array.from({ length: 10 }, () => new Float32Array(n).fill(Number.NaN));
  raw.forEach((r, b) => {
    const { slope, offset } = HLS_MSI_TO_OLI[b];
    const dst = bands[LANDSAT_TO_S2[b]];
    for (let i = 0; i < n; i++) dst[i] = (r[i] * s.scale + s.offset - offset) / slope;
  });
  // Landsat has one NIR band; B08 takes it too, as HLS does.
  bands[6].set(bands[7]);
  for (let i = 0; i < n; i++) if (ok[i] && (!Number.isFinite(bands[0][i]) || bands[0][i] > HAZE_BLUE || !(bands[7][i] > 0))) ok[i] = 0;
  return { date: s.datetime.slice(0, 10), bands, ok };
}

export async function buildMonth(g: BlockGrid, month: string, fetchJson: FetchJson, log: (m: string) => void = () => {}): Promise<MonthComposite> {
  const [from, to] = monthRange(month);
  const bbox = gridLonLatBbox(g);
  const n = g.width * g.height;

  // --- Sentinel-2 ---------------------------------------------------------------------------------
  const s2All = await searchS2(fetchJson, bbox, from, to);
  const same = s2All.filter((s) => s.epsg === g.epsg);
  const s2 = (same.length ? same : s2All).sort((a, b) => a.cloud - b.cloud).slice(0, MAX_S2_SCENES);
  const obs: Obs[] = [];
  for (let i = 0; i < s2.length; i += 3) {
    const got = await Promise.all(
      s2.slice(i, i + 3).map((s) =>
        readS2Scene(s, g).catch((e) => {
          log(`  s2 ${s.id} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
      ),
    );
    for (const o of got) if (o) obs.push(o);
  }
  obs.sort((a, b) => a.date.localeCompare(b.date));
  const s2c = compositeObservations(obs, n, 10);
  const refl = s2c.refl;
  const s2Obs = s2c.count;

  // --- Landsat fill -------------------------------------------------------------------------------
  const need = new Uint8Array(n);
  let gaps = 0;
  for (let i = 0; i < n; i++) if (!s2Obs[i]) (need[i] = 1), gaps++;
  const landsatObs = new Uint8Array(n);
  const landsatUsed: string[] = [];
  if (gaps > n * 0.001) {
    const ls = (await searchLandsat(fetchJson, bbox, from, to)).sort((a, b) => a.cloud - b.cloud).slice(0, MAX_LANDSAT_SCENES);
    if (ls.length) {
      const token = await pcToken(fetchJson, "landsat-c2-l2");
      const lobs: Obs[] = [];
      for (const s of ls) {
        const o = await readLandsatScene(s, g, token, need).catch((e) => {
          log(`  landsat ${s.id} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (o) {
          lobs.push(o);
          landsatUsed.push(s.id);
        }
      }
      const lc = compositeObservations(lobs, n, 10);
      for (let i = 0; i < n; i++) {
        if (!need[i] || !lc.count[i]) continue;
        for (let b = 0; b < 10; b++) refl[b][i] = lc.refl[b][i];
        landsatObs[i] = lc.count[i];
      }
    }
  }
  const optOk = new Uint8Array(n);
  const reOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (s2Obs[i]) optOk[i] = reOk[i] = 1;
    else if (landsatObs[i]) optOk[i] = 1;
  }

  // --- Sentinel-1 ---------------------------------------------------------------------------------
  const vv = new Float32Array(n).fill(Number.NaN);
  const vh = new Float32Array(n).fill(Number.NaN);
  const s1Obs = new Uint8Array(n);
  const radar = (await searchRadar(fetchJson, { bbox }, from, new Date(to.getTime() - 1))).slice(0, MAX_S1_SCENES);
  const s1Used: string[] = [];
  if (radar.length) {
    const token = await pcToken(fetchJson, "sentinel-1-rtc");
    const stacks: { vv: Float32Array; vh: Float32Array }[] = [];
    for (const r of radar) {
      try {
        const [a, b] = await Promise.all([readToGrid(r.vv, g, { epsg: r.epsg, token, nodata: null }), readToGrid(r.vh, g, { epsg: r.epsg, token, nodata: null })]);
        stacks.push({ vv: a, vh: b });
        s1Used.push(r.id);
      } catch (e) {
        log(`  s1 ${r.id} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const bv: number[] = [];
    const bh: number[] = [];
    for (let i = 0; i < n; i++) {
      bv.length = 0;
      bh.length = 0;
      for (const s of stacks) {
        const a = s.vv[i];
        const b = s.vh[i];
        if (a > 0 && b > 0) {
          bv.push(10 * Math.log10(a));
          bh.push(10 * Math.log10(b));
        }
      }
      if (bv.length) {
        vv[i] = median(bv);
        vh[i] = median(bh);
        s1Obs[i] = bv.length;
      }
    }
  }
  return { month, grid: g, refl, optOk, reOk, s2Obs, landsatObs, vv, vh, s1Obs, scenes: { s2: obs.length ? s2.map((s) => s.id) : [], landsat: landsatUsed, s1: s1Used } };
}

/** Copernicus DEM GLO-30 elevation on the grid (metres), from every DEM tile the block touches. */
export async function buildDem(g: BlockGrid, fetchJson: FetchJson): Promise<Float32Array> {
  const tiles = await searchDem(fetchJson, gridLonLatBbox(g));
  const token = await pcToken(fetchJson, "cop-dem-glo-30");
  const n = g.width * g.height;
  const dem = new Float32Array(n).fill(Number.NaN);
  for (const t of tiles) {
    const z = await readToGrid(t.href, g, { epsg: 4326, token, nodata: null });
    for (let i = 0; i < n; i++) if (Number.isNaN(dem[i]) && Number.isFinite(z[i]) && z[i] > -1000) dem[i] = z[i];
  }
  // Fill any hole (sea, missing tile) with the block median so slope and relative elevation stay defined.
  const vals: number[] = [];
  for (let i = 0; i < n; i += 97) if (Number.isFinite(dem[i])) vals.push(dem[i]);
  const fill = vals.length ? median(vals) : 0;
  for (let i = 0; i < n; i++) if (!Number.isFinite(dem[i])) dem[i] = fill;
  return dem;
}
