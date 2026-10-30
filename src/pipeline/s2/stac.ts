/**
 * Sentinel-2 L2A scene search on Element84 Earth Search (AWS Open Data,
 * keyless). https://earth-search.aws.element84.com/v1
 */
export interface Scene {
  id: string;
  datetime: string;
  cloud: number;
  epsg: number;
  assets: { blue: string; green: string; red: string; nir: string; swir16: string; scl: string; visual: string };
  /**
   * Reflectance = DN * scale + offset. Since processing baseline 04.00 the advertised offset is -0.1, but
   * Earth Search has already removed it from the files when `earthsearch:boa_offset_applied` is true, so it
   * is applied only when that flag is false (see ts/catalog.ts s2Offset).
   */
  scale: number;
  offset: number;
}

const STAC = "https://earth-search.aws.element84.com/v1/search";

interface Feature {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, { href: string; "raster:bands"?: Array<{ scale?: number; offset?: number }> }>;
}

/**
 * Earth Search lists some acquisitions twice, once per processing run
 * (…_20200127_0_L2A and …_20200127_1_L2A). Keep one per tile and date, the
 * latest run, so a pass is never counted as two clear observations.
 */
export function dedupeScenes(scenes: Scene[]): Scene[] {
  const best = new Map<string, Scene>();
  for (const s of scenes) {
    const [, tile, date, run] = s.id.split("_");
    const key = `${tile}_${date}`;
    const prev = best.get(key);
    if (!prev || Number(run) > Number(prev.id.split("_")[3])) best.set(key, s);
  }
  return [...best.values()];
}

export async function searchScenes(
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>,
  bbox: [number, number, number, number],
  from: Date,
  to: Date,
  maxCloud = 90,
): Promise<Scene[]> {
  const body = {
    collections: ["sentinel-2-l2a"],
    bbox,
    datetime: `${from.toISOString()}/${to.toISOString()}`,
    limit: 100,
    query: { "eo:cloud_cover": { lt: maxCloud } },
  };
  const res = await fetchJson<{ features: Feature[] }>(STAC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const scenes = (res.features ?? [])
    .map((f) => {
      const a = f.assets;
      const rb = a.red?.["raster:bands"]?.[0] ?? {};
      return {
        id: f.id,
        datetime: String(f.properties.datetime),
        cloud: Number(f.properties["eo:cloud_cover"] ?? 100),
        epsg: Number(f.properties["proj:epsg"] ?? String(f.properties["proj:code"] ?? "").replace("EPSG:", "")),
        assets: {
          blue: a.blue?.href,
          green: a.green?.href,
          red: a.red?.href,
          nir: a.nir?.href,
          swir16: a.swir16?.href,
          scl: a.scl?.href,
          visual: a.visual?.href,
        },
        scale: rb.scale ?? 0.0001,
        offset: f.properties["earthsearch:boa_offset_applied"] === true ? 0 : (rb.offset ?? 0),
      } as Scene;
    })
    .filter((s) => Object.values(s.assets).every((h) => typeof h === "string" && h.startsWith("https://")));
  return dedupeScenes(scenes);
}
