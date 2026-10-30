import proj4 from "proj4";
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";

/**
 * Windowed reads from Cloud-Optimized GeoTIFFs onto a GhanaWatch block grid, for every sensor the
 * time-series detector uses. Only the bytes of the window and the overview level needed are fetched.
 *
 * A file in the grid's own projection is read with a straight window; a file in another projection
 * (a Landsat scene centred in the next UTM zone, the Copernicus DEM in latitude/longitude) is sampled
 * pixel by pixel through proj4. Both use the nearest source pixel, the same rule as the training data.
 */
export const ALLOWED_HOSTS = [
  "https://sentinel-cogs.s3.us-west-2.amazonaws.com/", // Sentinel-2 L2A, Element84 Earth Search (AWS Open Data)
  "https://landsateuwest.blob.core.windows.net/", // Landsat Collection 2 Level-2, Microsoft Planetary Computer
  "https://sentinel1euwestrtc.blob.core.windows.net/", // Sentinel-1 RTC, Microsoft Planetary Computer
  "https://elevationeuwest.blob.core.windows.net/", // Copernicus DEM GLO-30, Microsoft Planetary Computer
];

export interface BlockGrid {
  epsg: number;
  /** [minX, minY, maxX, maxY] in metres, snapped to res. */
  bbox: [number, number, number, number];
  res: number;
  width: number;
  height: number;
}

export function blockGrid(epsg: number, bbox: [number, number, number, number], res: number): BlockGrid {
  const minX = Math.floor(bbox[0] / res) * res;
  const minY = Math.floor(bbox[1] / res) * res;
  const maxX = Math.ceil(bbox[2] / res) * res;
  const maxY = Math.ceil(bbox[3] / res) * res;
  return { epsg, bbox: [minX, minY, maxX, maxY], res, width: Math.round((maxX - minX) / res), height: Math.round((maxY - minY) / res) };
}

const defined = new Set<string>();
export function defineEpsg(epsg: number) {
  const key = `EPSG:${epsg}`;
  if (defined.has(key) || epsg === 4326) return key;
  if (epsg >= 32601 && epsg <= 32660) proj4.defs(key, `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`);
  else if (epsg >= 32701 && epsg <= 32760) proj4.defs(key, `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`);
  else throw new Error(`unsupported projection EPSG:${epsg}`);
  defined.add(key);
  return key;
}

/** The block's corners and edge midpoints in longitude/latitude, as a bbox for catalogue searches. */
export function gridLonLatBbox(g: BlockGrid): [number, number, number, number] {
  const from = defineEpsg(g.epsg);
  const [x0, y0, x1, y1] = g.bbox;
  const pts = [
    [x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2],
  ].map((p) => proj4(from, "EPSG:4326", p) as [number, number]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

const cache = new Map<string, Promise<GeoTIFF>>();

function open(url: string, token?: string): Promise<GeoTIFF> {
  if (!ALLOWED_HOSTS.some((h) => url.startsWith(h))) throw new Error(`COG host not allowed: ${url.slice(0, 80)}`);
  const full = token ? `${url}?${token}` : url;
  let p = cache.get(full);
  if (!p) {
    p = fromUrl(full, { allowFullFile: false });
    cache.set(full, p);
    p.catch(() => cache.delete(full));
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return p;
}

async function pickOverview(tiff: GeoTIFF, full: GeoTIFFImage, fullRes: number, res: number) {
  let chosen = full;
  let chosenRes = fullRes;
  if (res <= fullRes + 1e-6) return { chosen, chosenRes };
  const count = await tiff.getImageCount();
  for (let i = 1; i < count; i++) {
    const img = await tiff.getImage(i);
    const r = fullRes * (full.getWidth() / img.getWidth());
    if (r <= res + 1e-6) {
      chosen = img;
      chosenRes = r;
    }
  }
  return { chosen, chosenRes };
}

export interface ReadOptions {
  /** Projection of the file (EPSG code). */
  epsg: number;
  /** Appended as a query string (Planetary Computer read token). */
  token?: string;
  /** Value of empty pixels in the file; they come back as `fill`. */
  nodata?: number | null;
  fill?: number;
}

/**
 * One band onto the grid as Float32 (raw file values), `fill` (default NaN) where the file has no data.
 * Exceptions from the network are retried a few times.
 */
export async function readToGrid(url: string, g: BlockGrid, o: ReadOptions): Promise<Float32Array> {
  return withRetry(() => readOnce(url, g, o));
}

async function readOnce(url: string, g: BlockGrid, o: ReadOptions): Promise<Float32Array> {
  const fill = o.fill ?? Number.NaN;
  const out = new Float32Array(g.width * g.height).fill(fill);
  const tiff = await open(url, o.token);
  const full = await tiff.getImage(0);
  const [originX, originY] = full.getOrigin();
  const [fullResX, fullResYraw] = full.getResolution();
  const fullResY = Math.abs(fullResYraw);
  const nod = o.nodata === undefined ? (full.getGDALNoData() ?? null) : o.nodata;

  if (o.epsg === g.epsg) {
    const { chosen, chosenRes } = await pickOverview(tiff, full, fullResX, g.res);
    const imgW = chosen.getWidth();
    const imgH = chosen.getHeight();
    const resY = chosenRes * (fullResY / fullResX);
    const c0 = Math.floor((g.bbox[0] - originX) / chosenRes);
    const r0 = Math.floor((originY - g.bbox[3]) / resY);
    const c1 = Math.ceil((g.bbox[2] - originX) / chosenRes);
    const r1 = Math.ceil((originY - g.bbox[1]) / resY);
    const wc0 = Math.max(0, c0), wr0 = Math.max(0, r0), wc1 = Math.min(imgW, c1), wr1 = Math.min(imgH, r1);
    if (wc1 <= wc0 || wr1 <= wr0) return out;
    const data = (await chosen.readRasters({ window: [wc0, wr0, wc1, wr1], samples: [0], interleave: false }))[0] as ArrayLike<number>;
    const ww = wc1 - wc0;
    for (let y = 0; y < g.height; y++) {
      const sr = Math.floor((originY - (g.bbox[3] - (y + 0.5) * g.res)) / resY) - wr0;
      if (sr < 0 || sr >= wr1 - wr0) continue;
      for (let x = 0; x < g.width; x++) {
        const sc = Math.floor((g.bbox[0] + (x + 0.5) * g.res - originX) / chosenRes) - wc0;
        if (sc < 0 || sc >= ww) continue;
        const v = data[sr * ww + sc];
        if (nod !== null && v === nod) continue;
        out[y * g.width + x] = v;
      }
    }
    return out;
  }

  // Different projection: sample through proj4 at full resolution (or the overview nearest the grid).
  const from = defineEpsg(g.epsg);
  const to = defineEpsg(o.epsg);
  const geographic = o.epsg === 4326;
  const approxRes = geographic ? g.res / 111_320 : g.res;
  const { chosen, chosenRes } = await pickOverview(tiff, full, fullResX, approxRes);
  const resY = chosenRes * (fullResY / fullResX);
  const imgW = chosen.getWidth();
  const imgH = chosen.getHeight();
  const cols = new Float64Array(g.width * g.height);
  const rows = new Float64Array(g.width * g.height);
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const [sx, sy] = proj4(from, to, [g.bbox[0] + (x + 0.5) * g.res, g.bbox[3] - (y + 0.5) * g.res]) as [number, number];
      const c = Math.floor((sx - originX) / chosenRes);
      const r = Math.floor((originY - sy) / resY);
      const i = y * g.width + x;
      cols[i] = c;
      rows[i] = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  const wc0 = Math.max(0, minC), wr0 = Math.max(0, minR), wc1 = Math.min(imgW, maxC + 1), wr1 = Math.min(imgH, maxR + 1);
  if (wc1 <= wc0 || wr1 <= wr0) return out;
  const data = (await chosen.readRasters({ window: [wc0, wr0, wc1, wr1], samples: [0], interleave: false }))[0] as ArrayLike<number>;
  const ww = wc1 - wc0;
  for (let i = 0; i < out.length; i++) {
    const c = cols[i] - wc0;
    const r = rows[i] - wr0;
    if (c < 0 || r < 0 || c >= ww || r >= wr1 - wr0) continue;
    const v = data[r * ww + c];
    if (nod !== null && v === nod) continue;
    out[i] = v;
  }
  return out;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
