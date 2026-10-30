import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import type { Grid } from "@/pipeline/s2/cog";

/**
 * Sentinel-1 radar from Microsoft Planetary Computer, keyless: the
 * "sentinel-1-rtc" collection (radiometrically terrain-corrected backscatter,
 * VV and VH, 10 m, Cloud-Optimized GeoTIFFs in UTM). Reading the files needs a
 * short-lived anonymous access token from the Planetary Computer token API.
 */
const STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-1-rtc";
export const S1_COG_PREFIX = "https://sentinel1euwestrtc.blob.core.windows.net/";

type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface RadarScene {
  id: string;
  datetime: string;
  orbit: "ascending" | "descending";
  platform: string;
  epsg: number;
  vv: string;
  vh: string;
}

let token: { value: string; expires: number } | null = null;

/** A Planetary Computer read token, renewed five minutes before it expires. */
export async function sasToken(fetchJson: FetchJson): Promise<string> {
  if (token && token.expires - Date.now() > 5 * 60_000) return token.value;
  const res = await fetchJson<{ token: string; "msft:expiry": string }>(TOKEN_URL);
  token = { value: res.token, expires: new Date(res["msft:expiry"]).getTime() };
  return token.value;
}

interface Feature {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, { href: string }>;
}

export async function searchRadar(fetchJson: FetchJson, area: { bbox: [number, number, number, number] } | { point: [number, number] }, from: Date, to: Date): Promise<RadarScene[]> {
  const body = {
    collections: ["sentinel-1-rtc"],
    ...("bbox" in area ? { bbox: area.bbox } : { intersects: { type: "Point", coordinates: area.point } }),
    datetime: `${from.toISOString()}/${to.toISOString()}`,
    limit: 100,
  };
  const res = await fetchJson<{ features?: Feature[] }>(STAC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (res.features ?? [])
    .map((f) => ({
      id: f.id,
      datetime: String(f.properties.datetime),
      orbit: (f.properties["sat:orbit_state"] === "ascending" ? "ascending" : "descending") as RadarScene["orbit"],
      platform: String(f.properties.platform ?? f.id.slice(0, 3)),
      epsg: Number(f.properties["proj:epsg"] ?? String(f.properties["proj:code"] ?? "").replace("EPSG:", "")),
      vv: f.assets.vv?.href,
      vh: f.assets.vh?.href,
    }))
    .filter((s) => s.vv?.startsWith(S1_COG_PREFIX) && s.vh?.startsWith(S1_COG_PREFIX) && Number.isFinite(s.epsg))
    .sort((a, b) => b.datetime.localeCompare(a.datetime));
}

const files = new Map<string, Promise<GeoTIFF>>();

function open(href: string, sas: string): Promise<GeoTIFF> {
  if (!href.startsWith(S1_COG_PREFIX)) throw new Error(`radar host not allowed: ${href}`);
  const key = `${href}?${sas}`;
  let p = files.get(key);
  if (!p) {
    p = fromUrl(key, { allowFullFile: false });
    files.set(key, p);
    p.catch(() => files.delete(key));
    if (files.size > 40) files.delete(files.keys().next().value!);
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

/**
 * Backscatter in decibels on a UTM grid (the scene's own zone), NaN where the
 * scene has no data. Nearest-neighbour from the closest overview not coarser
 * than the grid.
 */
export async function readRadarDb(href: string, sas: string, grid: Grid): Promise<Float32Array> {
  const tiff = await open(href, sas);
  const full = await tiff.getImage(0);
  const [originX, originY] = full.getOrigin();
  const fullRes = full.getResolution()[0];
  const { chosen, chosenRes } = await pickOverview(tiff, full, fullRes, grid.res);
  const imgW = chosen.getWidth();
  const imgH = chosen.getHeight();
  const c0 = Math.floor((grid.bbox[0] - originX) / chosenRes);
  const r0 = Math.floor((originY - grid.bbox[3]) / chosenRes);
  const c1 = Math.ceil((grid.bbox[2] - originX) / chosenRes);
  const r1 = Math.ceil((originY - grid.bbox[1]) / chosenRes);
  const out = new Float32Array(grid.width * grid.height).fill(Number.NaN);
  const wc0 = Math.max(0, c0);
  const wr0 = Math.max(0, r0);
  const wc1 = Math.min(imgW, c1);
  const wr1 = Math.min(imgH, r1);
  if (wc1 <= wc0 || wr1 <= wr0) return out;
  const data = (await chosen.readRasters({ window: [wc0, wr0, wc1, wr1], samples: [0], interleave: false }))[0] as Float32Array;
  const ww = wc1 - wc0;
  const scale = grid.res / chosenRes;
  for (let y = 0; y < grid.height; y++) {
    const sr = Math.floor(r0 + (y + 0.5) * scale) - wr0;
    if (sr < 0 || sr >= wr1 - wr0) continue;
    for (let x = 0; x < grid.width; x++) {
      const sc = Math.floor(c0 + (x + 0.5) * scale) - wc0;
      if (sc < 0 || sc >= ww) continue;
      const v = data[sr * ww + sc];
      if (v > 0) out[y * grid.width + x] = 10 * Math.log10(v);
    }
  }
  return out;
}

/** The UTM zone (EPSG code) a radar file is projected in, from its GeoTIFF keys. */
export async function radarEpsg(href: string, sas: string): Promise<number> {
  const img = await (await open(href, sas)).getImage(0);
  const code = Number((img.getGeoKeys() as { ProjectedCSTypeGeoKey?: number }).ProjectedCSTypeGeoKey);
  return Number.isFinite(code) && code > 0 ? code : 32630;
}

/** Backscatter in dB to an 8-bit grey level: -25 dB (water) black, 0 dB and above white. */
export function dbToGrey(db: Float32Array): Uint8Array {
  const out = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) {
    const v = db[i];
    out[i] = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(((v + 25) / 25) * 255))) : 0;
  }
  return out;
}
