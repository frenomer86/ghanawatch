import type { Polygon } from "geojson";
import { makeGrid, type Grid } from "../s2/cog";
import { fromProj, toProj } from "../s2/process";
import { radarEpsg, readRadarDb, sasToken, searchRadar, type RadarScene } from "./pc";
import { hull } from "./water";

type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

/**
 * Flooded land seen by radar around a place and date. Sentinel-1 sees through the cloud that comes with
 * floods. Land that looked like land in the same weeks a year earlier and turns dark
 * (open water) on passes within a few days of the event is counted as flooded. Permanent rivers and lakes,
 * dark in both, are not. Flooded forest and tall crops can stay bright, so the outline is a minimum.
 */
export const FLOOD_RULES = { nowDb: -18, dryDb: -15, dropDb: 5, minPx: 25, res: 40, halfKm: 15, windowDays: 6, baselineDays: 30 };

export interface FloodPatch {
  areaHa: number;
  centre: { lon: number; lat: number };
  geom: Polygon;
}

export interface FloodExtent {
  patches: FloodPatch[];
  floodedHa: number;
  eventScenes: string[];
  baselineScenes: string[];
  coverage: number;
}

function median(stack: Float32Array[], n: number, min: number): Float32Array {
  const out = new Float32Array(n).fill(Number.NaN);
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (const s of stack) if (Number.isFinite(s[i])) buf.push(s[i]);
    if (buf.length < min) continue;
    buf.sort((a, b) => a - b);
    const m = buf.length >> 1;
    out[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
  }
  return out;
}

/** Flood mask from the event and dry-season medians (pure; exported for tests). */
export function floodMask(event: Float32Array, dry: Float32Array): Uint8Array {
  const r = FLOOD_RULES;
  const out = new Uint8Array(event.length);
  for (let i = 0; i < event.length; i++) if (event[i] < r.nowDb && dry[i] > r.dryDb && dry[i] - event[i] >= r.dropDb) out[i] = 1;
  return out;
}

export async function floodExtent(fetchJson: FetchJson, lon: number, lat: number, eventDate: Date): Promise<FloodExtent | null> {
  const r = FLOOD_RULES;
  const dLon = r.halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const dLat = r.halfKm / 110.57;
  const bbox: [number, number, number, number] = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  const day = 86_400_000;
  const eventScenes = await searchRadar(fetchJson, { bbox }, new Date(eventDate.getTime() - r.windowDays * day), new Date(eventDate.getTime() + r.windowDays * day));
  if (!eventScenes.length) return null;
  // Baseline: the same weeks a year earlier. In the savannah the dry season is darker than the wet season
  // (bare dry soil), so a dry-season baseline hides floods; the same season a year before compares like with like.
  const ref = eventDate.getTime() - 365 * day;
  const dryScenes = (
    await searchRadar(fetchJson, { bbox }, new Date(ref - r.baselineDays * day), new Date(ref + r.baselineDays * day))
  )
    .filter((s) => s.orbit === eventScenes[0].orbit)
    .slice(0, 6);
  if (dryScenes.length < 2) return null;
  const sas = await sasToken(fetchJson);
  const epsg = await radarEpsg(eventScenes[0].vv, sas);
  const corners = [toProj(epsg, bbox[0], bbox[1]), toProj(epsg, bbox[2], bbox[1]), toProj(epsg, bbox[0], bbox[3]), toProj(epsg, bbox[2], bbox[3])];
  const grid = makeGrid(
    [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
    r.res,
  );
  const n = grid.width * grid.height;
  const read = async (scenes: RadarScene[]) => (await Promise.all(scenes.map((s) => readRadarDb(s.vv, sas, grid).catch(() => null)))).filter((x): x is Float32Array => x !== null);
  const ev = median(await read(eventScenes.filter((s) => s.orbit === eventScenes[0].orbit).slice(0, 3)), n, 1);
  const dry = median(await read(dryScenes), n, 2);
  let both = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(ev[i]) && Number.isFinite(dry[i])) both++;
  if (process.env.FLOOD_DEBUG) {
    const q = (a: Float32Array) => { const v = [...a].filter(Number.isFinite).sort((x, y) => x - y); return [0.05, 0.25, 0.5, 0.75].map((p) => v[Math.floor(p * (v.length - 1))]?.toFixed(1)); };
    let dark = 0; for (let i = 0; i < n; i++) if (ev[i] < r.nowDb && !(dry[i] < r.nowDb)) dark++;
    console.log("event q", q(ev), "dry q", q(dry), "newly dark", dark);
  }
  const mask = floodMask(ev, dry);
  const patches = patchesOf(mask, grid, epsg);
  return {
    patches,
    floodedHa: Math.round(patches.reduce((a, p) => a + p.areaHa, 0)),
    eventScenes: eventScenes.map((s) => s.id),
    baselineScenes: dryScenes.map((s) => s.id),
    coverage: both / n,
  };
}

function patchesOf(mask: Uint8Array, grid: Grid, epsg: number): FloodPatch[] {
  const W = grid.width;
  const H = grid.height;
  const res = grid.res;
  const seen = new Uint8Array(mask.length);
  const out: FloodPatch[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const px: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      px.push(p);
      const x = p % W;
      const y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (seen[q] || !mask[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
    }
    if (px.length < FLOOD_RULES.minPx) continue;
    let sx = 0;
    let sy = 0;
    const pts: [number, number][] = [];
    for (const p of px) {
      const x = p % W;
      const y = (p - x) / W;
      const mx = grid.bbox[0] + (x + 0.5) * res;
      const my = grid.bbox[3] - (y + 0.5) * res;
      sx += mx;
      sy += my;
      pts.push([mx - res / 2, my + res / 2], [mx + res / 2, my - res / 2], [mx - res / 2, my - res / 2], [mx + res / 2, my + res / 2]);
    }
    const [lon, lat] = fromProj(epsg, sx / px.length, sy / px.length);
    const ring = hull(pts).map(([x, y]) => fromProj(epsg, x, y));
    ring.push(ring[0]);
    out.push({ areaHa: (px.length * res * res) / 10_000, centre: { lon, lat }, geom: { type: "Polygon", coordinates: [ring] } });
  }
  return out.sort((a, b) => b.areaHa - a.areaHa);
}
