import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import { stableId } from "@/lib/server/ids";
import { areaHectares, centroidOf } from "@/lib/geo";
import { analysisCells } from "@/lib/db/schema";
import type { Adapter, NormalisedEvent } from "./types";
import { hullMetres, type Component, type Composite } from "../s2/analysis";
import { fromProj, processCell, type CellResult, type CellSpec } from "../s2/process";
import { SurfaceWater } from "../context/surface-water";
import { dueCells } from "../s2/cells";
import type { Scene } from "../s2/stac";
import { detector } from "../ts/mode";

/**
 * Nationwide galamsey detection from Sentinel-2 L2A.
 *
 * Imagery: Element84 Earth Search on AWS Open Data (keyless, Copernicus
 * Sentinel data). Ghana is divided into 0.2° cells (analysis_cells); each run
 * scans the cells that are most overdue within a time budget, so the whole
 * country is covered in rotation and the main mining belts more often.
 *
 * Per cell, a cloud-masked median of the clearest scenes of the last 120 days
 * is compared with one from one to two years earlier. Reported:
 *  - surface_disturbance: vegetation cleared to bare ground, and new
 *    water-filled pits on any land (forest, farm, settlement, open ground)
 *    away from existing rivers and reservoirs. New pits are the characteristic
 *    galamsey signature.
 *  - water_change: rivers that turned muddy (priority mining cells only,
 *    where silt from mining is the dominant cause).
 * Each detection is then placed against OpenStreetMap schools, cemeteries,
 * clinics, settlements, farmland and protected areas by the pipeline runner.
 *
 * Since the multi-sensor detector (adapters/timeseries.ts) took over galamsey on land, this scan runs only
 * on the mining-belt cells and reports only rivers that turned muddy, unless GW_DETECTOR=legacy.
 */
const SLUG = "cdse-sentinel-2";
// 2.3 is the relaxed one-clear-pass rule (S2_MIN_AFTER_OBS=1); 2.2 the two-pass rule.
const METHOD = Number(process.env.S2_MIN_AFTER_OBS ?? 2) === 1 ? "s2-galamsey-2.3" : "s2-galamsey-2.2";

export const sentinel2Adapter: Adapter = {
  slug: SLUG,
  async run(ctx) {
    if (!ctx.db) throw new Error("database handle required");
    const db = ctx.db;
    const budgetMs = Number(process.env.S2_BUDGET_MINUTES ?? 40) * 60_000;
    const maxCells = Number(process.env.S2_MAX_CELLS ?? 1000);
    const concurrency = Math.max(1, Number(process.env.S2_CONCURRENCY ?? 2));
    const started = Date.now();
    // S2_CELLS (comma-separated ids) rescans just those cells first, e.g. after a change to the method.
    const only = process.env.S2_CELLS ? new Set(process.env.S2_CELLS.split(",").map((x) => x.trim())) : null;
    // S2_IMPORT_DIR reads finished cells from a scan run elsewhere (src/pipeline/s2/remote-scan.ts) instead of
    // downloading imagery here; they are saved exactly as a local scan would save them.
    const importDir = process.env.S2_IMPORT_DIR ?? null;
    const riversOnly = detector() !== "legacy";
    const queue = (importDir ? (await db.select().from(analysisCells)).filter((c) => existsSync(join(importDir, `${c.id}.json`))) : only ? (await dueCells(db, ctx.now, 10_000)).filter((c) => only.has(c.id)) : await dueCells(db, ctx.now, maxCells)).filter(
      (c) => !riversOnly || c.priority >= 2,
    );
    const water = new SurfaceWater();
    const events: NormalisedEvent[] = [];
    const notes: string[] = [];
    let done = 0;

    const worker = async () => {
      while (queue.length && Date.now() - started < budgetMs) {
        const c = queue.shift()!;
        const t0 = Date.now();
        let out: CellScan;
        if (importDir) {
          const file = join(importDir, `${c.id}.json`);
          if (!existsSync(file)) continue;
          out = readCellScan(readFileSync(file, "utf8"));
        } else {
          out = await scanCell(c, ctx.now, ctx.fetchJson, ctx.log, water);
        }
        const { status, note } = out;
        // Muddy rivers only, when the multi-sensor detector handles land.
        const evs = riversOnly ? out.evs.filter((e) => e.type === "water_change") : out.evs;
        const scannedAt = new Date(out.scannedAt);
        if (status === "failed") notes.push(`${c.id}: ${note}`);
        // Save this cell's detections now, so a stopped run never loses finished cells. A failed save
        // leaves the cell unmarked so it is rescanned; it never stops the rest of the scan.
        try {
          await saveWithRetry(async () => {
            if (ctx.emit) await ctx.emit(evs);
            else events.push(...evs);
          });
          await saveWithRetry(() =>
            db
              .update(analysisCells)
              .set({
                // A failed cell keeps its old date, so it stays first in line for the next run.
                lastRunAt: status === "failed" ? undefined : scannedAt,
                lastStatus: status,
                coverageAfter: out.coverageAfter,
                sites: evs.filter((e) => e.type === "surface_disturbance").length,
                turbid: evs.filter((e) => e.type === "water_change").length,
                note,
                updatedAt: new Date(),
              })
              .where(eq(analysisCells.id, c.id))
              .then(() => undefined),
          );
          // A detection this cell's new scan no longer finds (a shadow or haze the improved checks now
          // reject, or a site whose outline moved) is hidden, not deleted. Only untouched ones: anything a
          // moderator reviewed stays as it is. If a later scan finds it again, it comes back.
          if (status === "ok") {
            const keep = evs.map((e) => e.sourceEventId);
            await saveWithRetry(() =>
              db
                .execute(
                  sql`update change_events set status = 'dismissed',
                    properties = coalesce(properties, '{}'::jsonb) || jsonb_build_object('autoDismissed', ${`not found again when the area was rescanned on ${scannedAt.toISOString().slice(0, 10)}`}::text)
                  where method_version like 's2-galamsey-2.%' and status = 'new' and properties->>'cell' = ${c.id}::text
                    and (${!riversOnly} or type = 'water_change')
                    and source_event_id not in (select jsonb_array_elements_text(${JSON.stringify(keep)}::text::jsonb))`,
                )
                .then(() => undefined),
            );
          }
        } catch (err) {
          const why = err instanceof Error ? `${err.message.slice(0, 120)}${err.cause ? ` (${String(err.cause).slice(0, 200)})` : ""}` : String(err);
          notes.push(`${c.id}: save failed, will rescan: ${why}`);
          ctx.log(`cdse-sentinel-2: cell ${c.id} save failed, will rescan: ${why}`);
          continue;
        }
        done++;
        ctx.log(
          `cdse-sentinel-2: cell ${c.id} (${c.regionName ?? "Ghana"}, ${c.resM} m) ${importDir ? "imported, " : ""}${status}, ${evs.length} detections, ` +
            `${out.coverageAfter ?? 0}% clear, ${out.waterSeenPx} px skipped as seasonal water, ${Math.round((Date.now() - t0) / 1000)} s`,
        );
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (done === 0) throw new Error(`No cell could be scanned. ${notes.slice(0, 3).join("; ")}`);
    ctx.log(`cdse-sentinel-2: scanned ${done} cells this run, ${queue.length} more due`);
    return { events, watermark: ctx.now, notes: notes.slice(0, 20), extra: { cellsScanned: done, cellsRemaining: queue.length } };
  },
};

/** One cell's scan outcome: everything the database needs, so a scan can run on another machine. */
export interface CellScan {
  id: string;
  scannedAt: string;
  status: "ok" | "no-imagery" | "failed";
  note: string | null;
  coverageAfter: number | null;
  waterSeenPx: number;
  evs: NormalisedEvent[];
}

type CellRow = { id: string; regionName: string | null; minLon: number; minLat: number; maxLon: number; maxLat: number; resM: number; priority: number };

export async function scanCell(
  c: CellRow,
  now: Date,
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>,
  log: (m: string) => void,
  water: SurfaceWater,
): Promise<CellScan> {
  const spec: CellSpec = { id: c.id, name: c.regionName ?? "Ghana", bbox: [c.minLon, c.minLat, c.maxLon, c.maxLat], res: c.resM, turbidity: c.priority >= 2 };
  const base = { id: c.id, scannedAt: now.toISOString(), waterSeenPx: 0 };
  try {
    const r = await processCell(spec, now, fetchJson, log, water);
    if (!r) return { ...base, status: "no-imagery", note: "not enough clear Sentinel-2 imagery yet", coverageAfter: null, evs: [] };
    const evs = r.comps.map((comp) => toEvent(r, comp, now)).filter((e): e is NormalisedEvent => e !== null);
    return { ...base, status: "ok", note: null, coverageAfter: Math.round(r.coverage.after * 100), waterSeenPx: r.waterSeenPx, evs };
  } catch (err) {
    return { ...base, status: "failed", note: err instanceof Error ? err.message.slice(0, 300) : String(err), coverageAfter: null, evs: [] };
  }
}

/** Parse a CellScan file, turning the JSON date strings back into Dates. */
export function readCellScan(text: string): CellScan {
  const scan = JSON.parse(text) as CellScan;
  for (const e of scan.evs) {
    e.detectedAt = new Date(e.detectedAt);
    for (const im of e.images ?? []) im.acquiredAt = new Date(im.acquiredAt);
  }
  return scan;
}

function bboxPx(c: Component, W: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of c.pixels) {
    const x = p % W;
    const y = (p - x) / W;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** The scene with the clearest view of the component and a margin around it. */
function clearestScene(scenes: Scene[], comp: Composite, c: Component, W: number, H: number, res: number) {
  const b = bboxPx(c, W);
  const pad = Math.round(500 / res);
  const x0 = Math.max(0, b.minX - pad);
  const x1 = Math.min(W - 1, b.maxX + pad);
  const y0 = Math.max(0, b.minY - pad);
  const y1 = Math.min(H - 1, b.maxY + pad);
  let best: { scene: Scene; clear: number } | null = null;
  for (let k = 0; k < comp.sceneIds.length; k++) {
    const v = comp.valid[k];
    let ok = 0;
    let tot = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        ok += v[y * W + x];
        tot++;
      }
    }
    const frac = tot ? ok / tot : 0;
    const scene = scenes.find((s) => s.id === comp.sceneIds[k]);
    if (scene && (!best || frac > best.clear)) best = { scene, clear: frac };
  }
  return best;
}

export const NORTH_CAVEAT = "In the savannah north, flooded fields, burnt or newly ploughed land and streams in flood can look the same, so this is marked low confidence.";

function toEvent(res: CellResult, c: Component, now: Date): NormalisedEvent | null {
  const { grid, after, before, cell, epsg } = res;
  const W = grid.width;
  const H = grid.height;
  const pxHa = (grid.res * grid.res) / 10_000;
  const hull = hullMetres(c, grid).map(([x, y]) => fromProj(epsg, x, y));
  const geom: Polygon = { type: "Polygon", coordinates: [hull] };
  const areaHa = Math.round(c.pixels.length * pxHa * 100) / 100;
  const centre = centroidOf(geom);

  let obsSum = 0;
  let latest = "";
  for (const p of c.pixels) {
    obsSum += after.count[p];
    const k = after.lastIdx[p];
    if (k >= 0 && after.dates[k] > latest) latest = after.dates[k];
  }
  if (!latest) return null;
  const meanObs = obsSum / c.pixels.length;

  const afterPick = clearestScene(res.afterScenes, after, c, W, H, grid.res);
  const beforePick = clearestScene(res.beforeScenes, before, c, W, H, grid.res);

  const isTurbid = c.kind === "turbid";
  const pondOnly = !isTurbid && c.cleared === 0;
  const hasPonds = !isTurbid && c.ponds * pxHa >= 0.12;
  // Savannah north: flooded fields, burnt or newly ploughed land and streams in flood mimic pits and clearing
  // in the rainy season (checked against yearly cloud-free mosaics), so northern detections stay low confidence.
  const north = centre.lat > 8.0;
  const sourceEventId = `${isTurbid ? "w" : "d"}-${centre.lon.toFixed(3)}-${centre.lat.toFixed(3)}`;
  const id = stableId("event", `${SLUG}:${sourceEventId}`);

  let confidence: NormalisedEvent["confidence"];
  if (isTurbid) confidence = meanObs >= 3 ? "medium" : "low";
  else if (north) confidence = "low";
  else if (hasPonds && meanObs >= 3) confidence = "high";
  else if (hasPonds || meanObs >= 3) confidence = "medium";
  else confidence = "low";

  let severity: NormalisedEvent["severity"];
  if (isTurbid) severity = areaHa >= 5 ? "elevated" : "watch";
  else if (north) severity = areaHa >= 3 ? "watch" : "normal";
  else if (hasPonds) severity = areaHa >= 15 && confidence === "high" ? "urgent" : areaHa >= 2 ? "elevated" : "watch";
  else severity = areaHa >= 15 ? "elevated" : areaHa >= 3 ? "watch" : "normal";

  const haText = areaHa >= 10 ? Math.round(areaHa).toString() : areaHa.toFixed(1);
  const beforeMonth = beforePick?.scene.datetime.slice(0, 7) ?? "the baseline";
  const obsText = `Seen on about ${meanObs.toFixed(1)} clear observations in the last 120 days.`;
  const caveat = "This is a detected change, not a legal finding; ground verification is encouraged.";

  let titleEn: string;
  let titleTw: string;
  let descriptionEn: string;
  if (isTurbid) {
    titleEn = "River water turned muddy";
    titleTw = "Asubɔnten nsuo ayɛ dɔteɛ";
    descriptionEn = `Sentinel-2 shows about ${areaHa} ha of river or open water whose colour turned brown compared with imagery from ${beforeMonth} and earlier (turbidity index rose by at least 0.08). Silt from mining upstream is a common cause; heavy rain can also raise turbidity. ${obsText}`;
  } else if (pondOnly) {
    titleEn = `New water-filled pits, about ${haText} ha`;
    titleTw = `Amena foforɔ a nsuo ahyɛ mu, bɛyɛ ${haText} ha`;
    descriptionEn = `Sentinel-2 shows new open water covering about ${areaHa} ha where there was none in imagery from ${beforeMonth} and earlier, away from existing rivers and reservoirs. Clusters of new water-filled pits are the typical sign of galamsey, including on farms and near homes.${
      north ? ` ${NORTH_CAVEAT}` : ""
    } ${obsText} ${caveat}`;
  } else if (hasPonds) {
    titleEn = `Likely mining pits and ponds, about ${haText} ha`;
    titleTw = `Ɛte sɛ sikatutu amena ne nsuo, bɛyɛ ${haText} ha`;
    descriptionEn = `Sentinel-2 shows about ${areaHa} ha that was green vegetation in imagery from ${beforeMonth} and earlier and is now bare ground with new water-filled pits. Cleared land with new pits is the typical signature of small-scale mining (galamsey).${north ? ` ${NORTH_CAVEAT}` : ""} ${obsText} ${caveat}`;
  } else {
    titleEn = `Vegetation cleared to bare ground, about ${haText} ha`;
    titleTw = `Wɔatwa nnua ama asase ada hɔ, bɛyɛ ${haText} ha`;
    descriptionEn = `Sentinel-2 shows about ${areaHa} ha that was green vegetation in imagery from ${beforeMonth} and earlier and is now bare ground, without visible pits. Galamsey often starts this way, but farm clearing, quarrying or construction leave the same signal.${north ? ` ${NORTH_CAVEAT}` : ""} ${obsText} ${caveat}`;
  }
  const descriptionTw = isTurbid
    ? "Satellite kyerɛ sɛ asubɔnten nsuo ayɛ dɔteɛ."
    : hasPonds || pondOnly
      ? "Satellite kyerɛ amena foforɔ a nsuo ahyɛ mu. Eyi taa yɛ galamsey nsɛnkyerɛnne, nanso ɛhia sɛ wɔkɔhwɛ."
      : "Satellite kyerɛ sɛ nnua a na ɛwɔ hɔ no ayera ama asase ada hɔ.";

  const licence = "Copernicus Sentinel data terms (free, full and open)";
  const images: NonNullable<NormalisedEvent["images"]> = [];
  for (const [role, pick] of [
    ["latest", afterPick],
    ["before", beforePick],
  ] as const) {
    if (!pick) continue;
    images.push({
      role,
      sourceSlug: SLUG,
      productId: pick.scene.id,
      sensor: "Sentinel-2 MSI",
      acquiredAt: new Date(pick.scene.datetime),
      cloudCoverPct: Math.round((1 - pick.clear) * 1000) / 10,
      thumbnailUrl: `/api/v1/events/${id}/image?role=${role}`,
      tileUrlTemplate: pick.scene.assets.visual,
      licence,
    });
  }

  return {
    sourceSlug: SLUG,
    sourceEventId,
    type: isTurbid ? "water_change" : "surface_disturbance",
    detectedAt: now,
    imageDate: latest,
    confidence,
    confidenceScore: confidence === "high" ? 0.85 : confidence === "medium" ? 0.65 : 0.45,
    severity,
    areaHa,
    geom,
    titleEn,
    titleTw,
    descriptionEn,
    descriptionTw,
    methodVersion: METHOD,
    properties: {
      signature: isTurbid ? "turbid_water" : pondOnly ? "new_pits" : hasPonds ? "cleared_with_pits" : "cleared",
      cell: cell.id,
      resolutionM: grid.res,
      pixels: c.pixels.length,
      pondHa: Math.round(c.ponds * pxHa * 100) / 100,
      clearedHa: Math.round(c.cleared * pxHa * 100) / 100,
      hullAreaHa: Math.round(areaHectares(geom) * 100) / 100,
      meanClearObservations: Math.round(meanObs * 10) / 10,
      baselineScenes: res.beforeScenes.length,
      recentScenes: res.afterScenes.length,
    },
    images,
  };
}

async function saveWithRetry(fn: () => Promise<void>, attempts = 4): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
