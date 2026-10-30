/**
 * Catalogue searches for every sensor the time-series detector reads. All keyless:
 *  - Sentinel-2 L2A, all ten 10 m and 20 m bands plus the scene classification: Element84 Earth Search.
 *  - Landsat 8 and 9 Collection 2 Level-2 surface reflectance: Microsoft Planetary Computer.
 *  - Sentinel-1 radiometrically terrain-corrected backscatter, VV and VH: Microsoft Planetary Computer.
 *  - Copernicus DEM GLO-30: Microsoft Planetary Computer.
 * Planetary Computer files are read with a short-lived anonymous token per collection.
 */
type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

const EARTH_SEARCH = "https://earth-search.aws.element84.com/v1/search";
const PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const PC_TOKEN = (collection: string) => `https://planetarycomputer.microsoft.com/api/sas/v1/token/${collection}`;

/** Sentinel-2 band names in the order the model uses, with their Earth Search asset keys. */
export const S2_ASSETS = ["blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir08", "swir16", "swir22"] as const;

export interface S2Scene {
  id: string;
  datetime: string;
  tile: string;
  epsg: number;
  cloud: number;
  hrefs: string[]; // in S2_ASSETS order
  scl: string;
  visual: string;
  scale: number[];
  offset: number[];
}

export interface LandsatScene {
  id: string;
  datetime: string;
  platform: string;
  epsg: number;
  cloud: number;
  /** blue, green, red, nir08, swir16, swir22 */
  hrefs: string[];
  qa: string;
  scale: number;
  offset: number;
}

interface Feature {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, { href: string; "raster:bands"?: Array<{ scale?: number; offset?: number }> }>;
}

const epsgOf = (p: Record<string, unknown>) => Number(p["proj:epsg"] ?? String(p["proj:code"] ?? "").replace("EPSG:", ""));

async function post<T>(fetchJson: FetchJson, url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * The reflectance offset to apply to a Sentinel-2 band. Since processing baseline 04.00 (25 January 2022)
 * ESA stores L2A values with +1000 added, and the band metadata says offset -0.1. Earth Search has already
 * removed that +1000 from the files it serves when `earthsearch:boa_offset_applied` is true, yet keeps
 * advertising -0.1; applying it again puts every value 0.1 too low (half the blue band went negative).
 * So the offset is used only when the item says it has not been applied.
 */
export function s2Offset(props: Record<string, unknown>, advertised: number | undefined): number {
  if (props["earthsearch:boa_offset_applied"] === true) return 0;
  return advertised ?? 0;
}

/** All Sentinel-2 L2A scenes over the bbox in [from, to), one per tile and date (latest processing run). */
export async function searchS2(fetchJson: FetchJson, bbox: [number, number, number, number], from: Date, to: Date, maxCloud = 95): Promise<S2Scene[]> {
  const res = await post<{ features: Feature[] }>(fetchJson, EARTH_SEARCH, {
    collections: ["sentinel-2-l2a"],
    bbox,
    datetime: `${from.toISOString()}/${new Date(to.getTime() - 1).toISOString()}`,
    limit: 200,
    query: { "eo:cloud_cover": { lt: maxCloud } },
  });
  const scenes: S2Scene[] = [];
  for (const f of res.features ?? []) {
    const a = f.assets;
    const hrefs = S2_ASSETS.map((k) => a[k]?.href);
    if (!hrefs.every((h) => typeof h === "string" && h.startsWith("https://")) || !a.scl?.href) continue;
    const rb = S2_ASSETS.map((k) => a[k]?.["raster:bands"]?.[0] ?? {});
    scenes.push({
      id: f.id,
      datetime: String(f.properties.datetime),
      tile: f.id.split("_")[1] ?? "",
      epsg: epsgOf(f.properties),
      cloud: Number(f.properties["eo:cloud_cover"] ?? 100),
      hrefs: hrefs as string[],
      scl: a.scl.href,
      visual: a.visual?.href ?? "",
      scale: rb.map((b) => b.scale ?? 0.0001),
      offset: rb.map((b) => s2Offset(f.properties, b.offset)),
    });
  }
  // Earth Search lists some acquisitions twice (…_0_L2A and …_1_L2A); keep the latest run.
  const best = new Map<string, S2Scene>();
  for (const s of scenes) {
    const [, tile, date, run] = s.id.split("_");
    const key = `${tile}_${date}`;
    const prev = best.get(key);
    if (!prev || Number(run) > Number(prev.id.split("_")[3])) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
}

/** Landsat 8 and 9 Collection 2 Level-2 scenes (Landsat 7 is left out: its scan-line gaps since 2003). */
export async function searchLandsat(fetchJson: FetchJson, bbox: [number, number, number, number], from: Date, to: Date, maxCloud = 95): Promise<LandsatScene[]> {
  const res = await post<{ features: Feature[] }>(fetchJson, PC_STAC, {
    collections: ["landsat-c2-l2"],
    bbox,
    datetime: `${from.toISOString()}/${new Date(to.getTime() - 1).toISOString()}`,
    limit: 200,
    query: { platform: { in: ["landsat-8", "landsat-9"] }, "eo:cloud_cover": { lt: maxCloud } },
  });
  const out: LandsatScene[] = [];
  for (const f of res.features ?? []) {
    const a = f.assets;
    const keys = ["blue", "green", "red", "nir08", "swir16", "swir22"];
    const hrefs = keys.map((k) => a[k]?.href);
    if (!hrefs.every((h) => typeof h === "string") || !a.qa_pixel?.href) continue;
    const rb = a.red?.["raster:bands"]?.[0] ?? {};
    out.push({
      id: f.id,
      datetime: String(f.properties.datetime),
      platform: String(f.properties.platform),
      epsg: epsgOf(f.properties),
      cloud: Number(f.properties["eo:cloud_cover"] ?? 100),
      hrefs: hrefs as string[],
      qa: a.qa_pixel.href,
      scale: rb.scale ?? 2.75e-5,
      offset: rb.offset ?? -0.2,
    });
  }
  return out.sort((a, b) => a.datetime.localeCompare(b.datetime));
}

export interface DemTile {
  id: string;
  href: string;
}

export async function searchDem(fetchJson: FetchJson, bbox: [number, number, number, number]): Promise<DemTile[]> {
  const res = await post<{ features: Feature[] }>(fetchJson, PC_STAC, { collections: ["cop-dem-glo-30"], bbox, limit: 20 });
  return (res.features ?? []).filter((f) => f.assets.data?.href).map((f) => ({ id: f.id, href: f.assets.data.href }));
}

const tokens = new Map<string, { value: string; expires: number }>();

/** A Planetary Computer read token for one collection, renewed five minutes before it expires. */
export async function pcToken(fetchJson: FetchJson, collection: string): Promise<string> {
  const t = tokens.get(collection);
  if (t && t.expires - Date.now() > 5 * 60_000) return t.value;
  const res = await fetchJson<{ token: string; "msft:expiry": string }>(PC_TOKEN(collection));
  tokens.set(collection, { value: res.token, expires: new Date(res["msft:expiry"]).getTime() });
  return res.token;
}
