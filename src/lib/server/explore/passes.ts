import { PASS_HALF_SIZE_M, type PassFrame } from "@/lib/explore/imagery";
import { SCENE_ID_RE } from "@/lib/domain/validation";
import { ALLOWED_COG_PREFIX, makeGrid, readVisual, withRetry } from "@/pipeline/s2/cog";
import { fromProj, toProj } from "@/pipeline/s2/process";
import { Semaphore, TtlCache, roundCoord } from "./cache";
import { getJson } from "./fetch";

/**
 * Single Sentinel-2 passes over a spot, for the "latest passes" part of the
 * satellite film. The list comes from Earth Search (keyless STAC); each frame
 * is a 4 km square cut from the pass's true-colour Cloud-Optimized GeoTIFF on
 * the AWS open-data bucket, so it shows the ground exactly as the satellite
 * saw it on that date.
 */
const STAC = "https://earth-search.aws.element84.com/v1/search";
const DAY = 86_400_000;
export const PASS_WINDOW_DAYS = 400;

const listCache = new TtlCache<PassFrame[]>(500, 3 * 3_600_000);
const frameCache = new TtlCache<RenderedPass>(200, 24 * 3_600_000);
/** COG reads are network-bound and memory-hungry; keep a few in flight per process. */
const cogSlots = new Semaphore(4);

export interface SceneParts {
  zone: number;
  band: string;
  square: string;
  year: number;
  month: number;
  day: number;
}

export function parseSceneId(id: string): SceneParts | null {
  const m = id.match(SCENE_ID_RE);
  if (!m) return null;
  return { zone: Number(m[1]), band: m[2], square: m[3], year: Number(m[4]), month: Number(m[5]), day: Number(m[6]) };
}

/** True-colour COG of a scene on the Sentinel-2 open-data bucket (month without zero padding). */
export function tciUrl(id: string): string | null {
  const p = parseSceneId(id);
  if (!p) return null;
  return `${ALLOWED_COG_PREFIX}sentinel-s2-l2a-cogs/${p.zone}/${p.band}/${p.square}/${p.year}/${p.month}/${id}/TCI.tif`;
}

const epsgOf = (p: SceneParts) => (p.band >= "N" ? 32600 : 32700) + p.zone;

/** The square drawn for a pass, in the scene's own UTM zone, as lon/lat corners TL, TR, BR, BL. */
export function passCorners(epsg: number, lon: number, lat: number): PassFrame["corners"] {
  const [x, y] = toProj(epsg, lon, lat);
  const g = makeGrid([x - PASS_HALF_SIZE_M, y - PASS_HALF_SIZE_M, x + PASS_HALF_SIZE_M, y + PASS_HALF_SIZE_M], 10);
  const [x0, y0, x1, y1] = g.bbox;
  const c = (px: number, py: number) => fromProj(epsg, px, py).map((v) => Number(v.toFixed(6))) as [number, number];
  return [c(x0, y1), c(x1, y1), c(x1, y0), c(x0, y0)];
}

interface Candidate {
  scene: string;
  date: string;
  tileCloud: number;
}

/** The clearest pass of each calendar month, oldest first. */
export function clearestPerMonth(scenes: Candidate[]): Candidate[] {
  const byDate = new Map<string, Candidate>();
  for (const s of scenes) {
    const prev = byDate.get(s.date);
    if (!prev || s.tileCloud < prev.tileCloud) byDate.set(s.date, s);
  }
  const byMonth = new Map<string, Candidate>();
  for (const s of byDate.values()) {
    const m = s.date.slice(0, 7);
    const prev = byMonth.get(m);
    if (!prev || s.tileCloud < prev.tileCloud) byMonth.set(m, s);
  }
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function recentPasses(lon: number, lat: number, now = new Date()): Promise<PassFrame[]> {
  const pLon = roundCoord(lon);
  const pLat = roundCoord(lat);
  return listCache.get(`${pLon},${pLat}`, async () => {
    const body = {
      collections: ["sentinel-2-l2a"],
      intersects: { type: "Point", coordinates: [pLon, pLat] },
      datetime: `${new Date(now.getTime() - PASS_WINDOW_DAYS * DAY).toISOString()}/${now.toISOString()}`,
      limit: 200,
      query: { "eo:cloud_cover": { lt: 60 } },
      fields: { include: ["id", "properties.datetime", "properties.eo:cloud_cover"], exclude: ["assets", "links", "geometry", "bbox"] },
    };
    const res = await getJson<{ features?: Array<{ id: string; properties: { datetime?: string; "eo:cloud_cover"?: number } }> }>(STAC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    });
    const candidates: Candidate[] = (res.features ?? [])
      .filter((f) => parseSceneId(f.id) && f.properties.datetime)
      .map((f) => ({ scene: f.id, date: String(f.properties.datetime).slice(0, 10), tileCloud: Number(f.properties["eo:cloud_cover"] ?? 100) }));
    return clearestPerMonth(candidates).map((c) => {
      const epsg = epsgOf(parseSceneId(c.scene)!);
      const sp = new URLSearchParams({ scene: c.scene, lat: String(pLat), lon: String(pLon) });
      return { ...c, url: `/api/v1/explore/pass?${sp}`, corners: passCorners(epsg, pLon, pLat) };
    });
  });
}

export interface RenderedPass {
  jpeg: Buffer;
  /** Share of the square that is bright cloud, and share outside the satellite's swath. */
  cloud: number;
  nodata: number;
}

/**
 * Bright in all three bands (blue included) reads as cloud; all-zero is outside
 * the swath. Bright laterite and roofs stay below the blue threshold or cover too
 * little of a 4 km square to matter.
 */
export function frameMetrics(rgb: Uint8Array): { cloud: number; nodata: number } {
  const n = rgb.length / 3;
  let cloud = 0;
  let nodata = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    if (r === 0 && g === 0 && b === 0) nodata++;
    else if (r >= 200 && g >= 200 && b >= 200) cloud++;
  }
  return { cloud: cloud / n, nodata: nodata / n };
}

export async function renderPass(scene: string, lon: number, lat: number): Promise<RenderedPass> {
  const parts = parseSceneId(scene);
  const href = tciUrl(scene);
  if (!parts || !href) throw new Error("Invalid scene id");
  const pLon = roundCoord(lon);
  const pLat = roundCoord(lat);
  return frameCache.get(`${scene}:${pLon},${pLat}`, () =>
    cogSlots.run(async () => {
      const epsg = epsgOf(parts);
      const [x, y] = toProj(epsg, pLon, pLat);
      const grid = makeGrid([x - PASS_HALF_SIZE_M, y - PASS_HALF_SIZE_M, x + PASS_HALF_SIZE_M, y + PASS_HALF_SIZE_M], 10);
      const rgb = await withRetry(() => readVisual(href, grid), 3);
      const metrics = frameMetrics(rgb);
      const sharp = (await import("sharp")).default;
      const jpeg = await sharp(Buffer.from(rgb), { raw: { width: grid.width, height: grid.height, channels: 3 } })
        .modulate({ brightness: 1.2 })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
      return { jpeg, ...metrics };
    }),
  );
}
