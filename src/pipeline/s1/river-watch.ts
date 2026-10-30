import proj4 from "proj4";
import { makeGrid } from "@/pipeline/s2/cog";
import { readRadarDb, type RadarScene } from "./pc";

/**
 * River watch on one Sentinel-1 pass: strong radar reflections sitting on open
 * water of the watched rivers, where dredgers and floating mining platforms
 * (changfan) show up as bright points against dark water.
 *
 * Wind, rain, banks and bridges also make bright returns, so the rules are
 * strict: a reflection of at least +3 dB that is a local peak, small (at most
 * ten bright pixels, not a building), with open water (below -15 dB) around it,
 * on a stretch where the river shows as water and is not roughened overall,
 * and more than 150 m from any mapped bridge, dam or weir. One pass is never
 * enough: the adapter only raises a flag when a reflection repeats on another
 * day, and a moderator checks it before it is published.
 */
export interface RiverLine {
  name: string | null;
  coords: [number, number][];
}

export type Skip = "outside" | "no-water" | "rough" | null;

export interface RiverTarget {
  lon: number;
  lat: number;
  vvDb: number;
  vhDb: number | null;
  river: string | null;
}

const WINDOW_M = 3000;
const RES = 10;
const NEAR_PX = 4; // 40 m either side of the mapped centre line
const ZONE_PX = 8; // 80 m, for the water statistics of the stretch
const STRUCTURE_M = 150;
export const RULES = { targetDb: 3, waterDb: -15, roughDb: -8, maxRoughShare: 0.3, minWaterPx: 30, maxBlobPx: 10, blobDb: -4, minWaterAround: 6 };

const projDef = (epsg: number) => `EPSG:${epsg}`;
function ensureProj(epsg: number) {
  if (!proj4.defs(projDef(epsg))) proj4.defs(projDef(epsg), `+proj=utm +zone=${epsg % 100} +datum=WGS84 +units=m +no_defs`);
}

/** River centre lines resampled every 20 m in the scene's UTM zone, grouped by 3 km window. */
export function riverWindows(rivers: RiverLine[], epsg: number): Map<string, Array<{ x: number; y: number; river: string | null }>> {
  ensureProj(epsg);
  const windows = new Map<string, Array<{ x: number; y: number; river: string | null }>>();
  for (const r of rivers) {
    const pts = r.coords.map(([lon, lat]) => proj4("EPSG:4326", projDef(epsg), [lon, lat]) as [number, number]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      for (let t = 0; t <= len; t += 20) {
        const x = ax + ((bx - ax) * t) / (len || 1);
        const y = ay + ((by - ay) * t) / (len || 1);
        const key = `${Math.floor(x / WINDOW_M)}:${Math.floor(y / WINDOW_M)}`;
        if (!windows.has(key)) windows.set(key, []);
        windows.get(key)!.push({ x, y, river: r.name });
      }
    }
  }
  return windows;
}

export async function scanRiverWindow(
  scene: RadarScene,
  sas: string,
  key: string,
  pts: Array<{ x: number; y: number; river: string | null }>,
  structures: Array<[number, number]>,
): Promise<{ targets: RiverTarget[]; skipped: Skip }> {
  const [kx, ky] = key.split(":").map(Number);
  const pad = 200;
  const grid = makeGrid([kx * WINDOW_M - pad, ky * WINDOW_M - pad, (kx + 1) * WINDOW_M + pad, (ky + 1) * WINDOW_M + pad], RES);
  const W = grid.width;
  const H = grid.height;
  const vv = await readRadarDb(scene.vv, sas, grid);
  let finite = 0;
  for (let i = 0; i < vv.length; i++) if (Number.isFinite(vv[i])) finite++;
  if (finite < vv.length * 0.2) return { targets: [], skipped: "outside" };

  const near = new Uint8Array(W * H);
  const zone = new Uint8Array(W * H);
  const riverAt = new Map<number, string | null>();
  for (const p of pts) {
    const col = Math.floor((p.x - grid.bbox[0]) / RES);
    const row = Math.floor((grid.bbox[3] - p.y) / RES);
    for (let dy = -ZONE_PX; dy <= ZONE_PX; dy++) {
      for (let dx = -ZONE_PX; dx <= ZONE_PX; dx++) {
        const r = row + dy;
        const c = col + dx;
        if (r < 0 || c < 0 || r >= H || c >= W) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > ZONE_PX * ZONE_PX) continue;
        const i = r * W + c;
        zone[i] = 1;
        if (d2 <= NEAR_PX * NEAR_PX) {
          near[i] = 1;
          riverAt.set(i, p.river);
        }
      }
    }
  }

  const { found, skipped } = findTargets(vv, W, H, near, zone);
  if (skipped) return { targets: [], skipped };
  if (!found.length) return { targets: [], skipped: null };

  const epsg = scene.epsg;
  ensureProj(epsg);
  const targets: RiverTarget[] = [];
  let vh: Float32Array | null = null;
  for (const f of found.sort((a, b) => b.db - a.db).slice(0, 20)) {
    const col = f.i % W;
    const row = (f.i - col) / W;
    const x = grid.bbox[0] + (col + 0.5) * RES;
    const y = grid.bbox[3] - (row + 0.5) * RES;
    if (structures.some(([sx, sy]) => Math.hypot(sx - x, sy - y) < STRUCTURE_M)) continue;
    vh ??= await readRadarDb(scene.vh, sas, grid);
    const [lon, lat] = proj4(projDef(epsg), "EPSG:4326", [x, y]) as [number, number];
    targets.push({
      lon: Number(lon.toFixed(6)),
      lat: Number(lat.toFixed(6)),
      vvDb: Math.round(f.db * 10) / 10,
      vhDb: Number.isFinite(vh[f.i]) ? Math.round(vh[f.i] * 10) / 10 : null,
      river: riverAt.get(f.i) ?? null,
    });
  }
  return { targets, skipped: null };
}

/**
 * The detection rules on one window of backscatter (dB): skip stretches where
 * the river does not show as water or is roughened by wind or rain, then keep
 * small bright peaks with water around them. Pure, for tests.
 */
export function findTargets(
  vv: Float32Array,
  W: number,
  H: number,
  near: Uint8Array,
  zone: Uint8Array,
): { found: Array<{ i: number; db: number }>; skipped: "no-water" | "rough" | null } {
  let water = 0;
  let nearCount = 0;
  let rough = 0;
  for (let i = 0; i < W * H; i++) {
    if (zone[i] && vv[i] < RULES.waterDb) water++;
    if (near[i] && Number.isFinite(vv[i])) {
      nearCount++;
      if (vv[i] > RULES.roughDb) rough++;
    }
  }
  if (water < RULES.minWaterPx) return { found: [], skipped: "no-water" };
  if (nearCount && rough / nearCount > RULES.maxRoughShare) return { found: [], skipped: "rough" };

  const found: Array<{ i: number; db: number }> = [];
  for (let row = 2; row < H - 2; row++) {
    for (let col = 2; col < W - 2; col++) {
      const i = row * W + col;
      const v = vv[i];
      if (!near[i] || !(v >= RULES.targetDb)) continue;
      let peak = true;
      let waterAround = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const n = vv[(row + dy) * W + col + dx];
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && n > v) peak = false;
          if (n < RULES.waterDb) waterAround++;
        }
      }
      if (!peak || waterAround < RULES.minWaterAround) continue;
      // A building or a stretch of bank lights up many pixels; a platform only a few.
      const seen = new Set<number>([i]);
      const stack = [i];
      while (stack.length && seen.size <= RULES.maxBlobPx) {
        const p = stack.pop()!;
        const pc = p % W;
        const pr = (p - pc) / W;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = (pr + dy) * W + pc + dx;
            if (pr + dy < 0 || pr + dy >= H || pc + dx < 0 || pc + dx >= W || seen.has(q) || !(vv[q] >= RULES.blobDb)) continue;
            seen.add(q);
            stack.push(q);
          }
        }
      }
      if (seen.size > RULES.maxBlobPx) continue;
      found.push({ i, db: v });
    }
  }
  return { found, skipped: null };
}

/** Bridges, dams and weirs in the scene's UTM zone. */
export function projectStructures(points: Array<[number, number]>, epsg: number): Array<[number, number]> {
  ensureProj(epsg);
  return points.map(([lon, lat]) => proj4("EPSG:4326", projDef(epsg), [lon, lat]) as [number, number]);
}
