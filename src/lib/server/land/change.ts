import { classify, composite, type SceneBands } from "@/pipeline/s2/analysis";
import { makeGrid } from "@/pipeline/s2/cog";
import { epsgFor, fromProj, loadScene, toProj } from "@/pipeline/s2/process";
import { searchScenes, type Scene } from "@/pipeline/s2/stac";
import { Semaphore } from "@/lib/server/explore/cache";
import { getJson } from "@/lib/server/explore/fetch";
import { pointInRing, type Plot } from "./plot";

/**
 * GhanaWatch's own Sentinel-2 comparison for a plot: a cloud-masked composite
 * of the 2020 dry season (December 2019 to March 2020) against one of the last
 * five months, classified with the same rules as the national galamsey scan
 * (vegetation cleared to bare ground; new open water away from rivers, which
 * is how mining pits show). 20 m pixels.
 */
export const BASELINE = { from: "2019-12-01", to: "2020-03-31" };
const RECENT_DAYS = 150;
const MAX_SCENES = 5;
const RES_M = 20;
const slots = new Semaphore(6);

export interface PlotChange {
  status: "ok" | "cloudy" | "no-imagery";
  clearedHa: number;
  newWaterHa: number;
  /** Share of the plot seen clearly in both periods. */
  coverage: number;
  before: { from: string; to: string; scenes: string[] };
  after: { from: string; to: string; scenes: string[] };
}

function pick(scenes: Scene[], epsg: number): Scene[] {
  const same = scenes.filter((s) => s.epsg === epsg);
  return (same.length ? same : scenes).sort((a, b) => a.cloud - b.cloud).slice(0, MAX_SCENES);
}

async function loadAll(scenes: Scene[], grid: ReturnType<typeof makeGrid>): Promise<SceneBands[]> {
  const out = await Promise.all(scenes.map((s) => slots.run(() => loadScene(s, grid)).catch(() => null)));
  return out.filter((b): b is SceneBands => b !== null);
}

export async function plotChange(plot: Plot, now = new Date()): Promise<PlotChange> {
  const fetchJson = <T,>(url: string, init?: RequestInit) => getJson<T>(url, { ...init, timeoutMs: 20_000 });
  const recentFrom = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  const [older, recent] = await Promise.all([
    searchScenes(fetchJson, plot.bbox, new Date(`${BASELINE.from}T00:00:00Z`), new Date(`${BASELINE.to}T23:59:59Z`), 50),
    searchScenes(fetchJson, plot.bbox, recentFrom, now, 70),
  ]);
  let epsg = epsgFor(plot.center.lon);
  const afterScenes = pick(recent, epsg);
  if (afterScenes[0] && afterScenes[0].epsg !== epsg) epsg = afterScenes[0].epsg;
  const beforeScenes = pick(older, epsg);
  const periods = {
    before: { ...BASELINE, scenes: beforeScenes.map((s) => s.id) },
    after: { from: recentFrom.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), scenes: afterScenes.map((s) => s.id) },
  };
  if (!beforeScenes.length || !afterScenes.length) return { status: "no-imagery", clearedHa: 0, newWaterHa: 0, coverage: 0, ...periods };

  const [minLon, minLat, maxLon, maxLat] = plot.bbox;
  const corners = [toProj(epsg, minLon, minLat), toProj(epsg, maxLon, minLat), toProj(epsg, minLon, maxLat), toProj(epsg, maxLon, maxLat)];
  const grid = makeGrid(
    [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
    RES_M,
  );
  const n = grid.width * grid.height;
  const [beforeBands, afterBands] = await Promise.all([loadAll(beforeScenes, grid), loadAll(afterScenes, grid)]);
  if (!beforeBands.length || !afterBands.length) return { status: "no-imagery", clearedHa: 0, newWaterHa: 0, coverage: 0, ...periods };
  const before = composite(beforeBands, n);
  const after = composite(afterBands, n);
  const cls = classify(before, after, grid, { turbidity: false });

  const pxHa = (RES_M * RES_M) / 10_000;
  let inside = 0;
  let seen = 0;
  let cleared = 0;
  let water = 0;
  for (let row = 0; row < grid.height; row++) {
    const y = grid.bbox[3] - (row + 0.5) * RES_M;
    for (let col = 0; col < grid.width; col++) {
      const [lon, lat] = fromProj(epsg, grid.bbox[0] + (col + 0.5) * RES_M, y);
      if (!pointInRing(lon, lat, plot.ring)) continue;
      inside++;
      const i = row * grid.width + col;
      if (before.count[i] && after.count[i] >= 2) seen++;
      if (cls[i] === 1) cleared++;
      else if (cls[i] === 2) water++;
    }
  }
  const coverage = inside ? seen / inside : 0;
  return {
    status: coverage >= 0.5 ? "ok" : "cloudy",
    clearedHa: Math.round(cleared * pxHa * 100) / 100,
    newWaterHa: Math.round(water * pxHa * 100) / 100,
    coverage: Math.round(coverage * 100) / 100,
    ...periods,
  };
}
