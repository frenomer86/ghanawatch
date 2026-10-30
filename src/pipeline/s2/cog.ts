import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";

/**
 * Windowed reads from Cloud-Optimized GeoTIFFs over HTTP range requests.
 * Only the bytes for the requested window and overview level are fetched.
 */
export const ALLOWED_COG_PREFIX = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/";

const cache = new Map<string, Promise<GeoTIFF>>();

function open(url: string): Promise<GeoTIFF> {
  if (!url.startsWith(ALLOWED_COG_PREFIX)) throw new Error(`COG host not allowed: ${url}`);
  let p = cache.get(url);
  if (!p) {
    p = fromUrl(url, { allowFullFile: false });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export interface Grid {
  /** UTM bbox snapped to the grid: [minX, minY, maxX, maxY] in metres. */
  bbox: [number, number, number, number];
  res: number;
  width: number;
  height: number;
}

export function makeGrid(bbox: [number, number, number, number], res: number): Grid {
  const minX = Math.floor(bbox[0] / res) * res;
  const minY = Math.floor(bbox[1] / res) * res;
  const maxX = Math.ceil(bbox[2] / res) * res;
  const maxY = Math.ceil(bbox[3] / res) * res;
  return { bbox: [minX, minY, maxX, maxY], res, width: Math.round((maxX - minX) / res), height: Math.round((maxY - minY) / res) };
}

/**
 * The overview whose resolution is closest to (not coarser than) the target.
 * At or below full resolution no overview can qualify, so their headers are
 * never fetched (each is another round trip on a cold file).
 */
async function pickOverview(tiff: GeoTIFF, full: GeoTIFFImage, fullRes: number, res: number): Promise<{ chosen: GeoTIFFImage; chosenRes: number }> {
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

/**
 * Read one band onto the target grid. Picks the overview whose resolution is
 * closest to (not coarser than) the grid resolution, then nearest-neighbour
 * resamples. Pixels outside the image are 0 (nodata).
 */
export async function readBand(url: string, grid: Grid): Promise<Uint16Array | Uint8Array> {
  const tiff = await open(url);
  const full = await tiff.getImage(0);
  const [originX, originY] = full.getOrigin();
  const fullRes = full.getResolution()[0];
  const { chosen, chosenRes } = await pickOverview(tiff, full, fullRes, grid.res);
  const imgW = chosen.getWidth();
  const imgH = chosen.getHeight();
  // Window in the chosen image's pixel space (origin is shared across overviews).
  const c0 = Math.floor((grid.bbox[0] - originX) / chosenRes);
  const r0 = Math.floor((originY - grid.bbox[3]) / chosenRes);
  const c1 = Math.ceil((grid.bbox[2] - originX) / chosenRes);
  const r1 = Math.ceil((originY - grid.bbox[1]) / chosenRes);
  const out = new (full.getBitsPerSample() > 8 ? Uint16Array : Uint8Array)(grid.width * grid.height);
  const wc0 = Math.max(0, c0), wr0 = Math.max(0, r0), wc1 = Math.min(imgW, c1), wr1 = Math.min(imgH, r1);
  if (wc1 <= wc0 || wr1 <= wr0) return out;
  const data = (await chosen.readRasters({ window: [wc0, wr0, wc1, wr1], samples: [0], interleave: false }))[0] as Uint16Array | Uint8Array;
  const ww = wc1 - wc0;
  const scale = grid.res / chosenRes;
  for (let y = 0; y < grid.height; y++) {
    const sr = Math.floor(r0 + (y + 0.5) * scale) - wr0;
    if (sr < 0 || sr >= wr1 - wr0) continue;
    for (let x = 0; x < grid.width; x++) {
      const sc = Math.floor(c0 + (x + 0.5) * scale) - wc0;
      if (sc < 0 || sc >= ww) continue;
      out[y * grid.width + x] = data[sr * ww + sc];
    }
  }
  return out;
}

/** Read an RGB 8-bit visual (TCI) window, returning interleaved RGB bytes. */
export async function readVisual(url: string, grid: Grid): Promise<Uint8Array> {
  const tiff = await open(url);
  const full = await tiff.getImage(0);
  const [originX, originY] = full.getOrigin();
  const fullRes = full.getResolution()[0];
  const { chosen, chosenRes } = await pickOverview(tiff, full, fullRes, grid.res);
  const c0 = Math.floor((grid.bbox[0] - originX) / chosenRes);
  const r0 = Math.floor((originY - grid.bbox[3]) / chosenRes);
  const c1 = Math.ceil((grid.bbox[2] - originX) / chosenRes);
  const r1 = Math.ceil((originY - grid.bbox[1]) / chosenRes);
  const imgW = chosen.getWidth(), imgH = chosen.getHeight();
  const wc0 = Math.max(0, c0), wr0 = Math.max(0, r0), wc1 = Math.min(imgW, c1), wr1 = Math.min(imgH, r1);
  const out = new Uint8Array(grid.width * grid.height * 3);
  if (wc1 <= wc0 || wr1 <= wr0) return out;
  const bands = (await chosen.readRasters({ window: [wc0, wr0, wc1, wr1], samples: [0, 1, 2], interleave: false })) as unknown as Uint8Array[];
  const ww = wc1 - wc0;
  const scale = grid.res / chosenRes;
  for (let y = 0; y < grid.height; y++) {
    const sr = Math.floor(r0 + (y + 0.5) * scale) - wr0;
    if (sr < 0 || sr >= wr1 - wr0) continue;
    for (let x = 0; x < grid.width; x++) {
      const sc = Math.floor(c0 + (x + 0.5) * scale) - wc0;
      if (sc < 0 || sc >= ww) continue;
      const i = sr * ww + sc;
      const o = (y * grid.width + x) * 3;
      out[o] = bands[0][i];
      out[o + 1] = bands[1][i];
      out[o + 2] = bands[2][i];
    }
  }
  return out;
}

/** Retry transient network failures (S3 occasionally drops connections). */
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
