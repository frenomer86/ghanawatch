import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import type { LineString, Point } from "geojson";
import { analysisCells, machinerySightings, radarCells, radarScenes, radarTargets, riverLines } from "@/lib/db/schema";
import { stableId, uuidv7 } from "@/lib/server/ids";
import { epsgFor } from "@/pipeline/s2/process";
import { sasToken, searchRadar, type RadarScene } from "@/pipeline/s1/pc";
import { loadRiverLines, riverLinesFresh } from "@/pipeline/s1/rivers";
import { projectStructures, riverWindows, scanRiverWindow, type RiverLine, type RiverTarget } from "@/pipeline/s1/river-watch";
import { hull, radarPonds, type RadarPond } from "@/pipeline/s1/water";
import { SurfaceWater, type WaterSeen } from "@/pipeline/context/surface-water";
import type { Adapter, AdapterContext, NormalisedEvent } from "./types";
import { detector } from "../ts/mode";

/**
 * Sentinel-1 radar (Microsoft Planetary Computer, keyless), which sees
 * through cloud. Two jobs per run:
 *
 * 1. River watch: the newest passes over the Pra, Ankobra, Offin, Birim and
 *    Tano are searched for strong reflections on open water (dredgers and
 *    floating mining platforms). A reflection repeated within 120 m on another
 *    day within 30 days becomes a dredger tag for a moderator to check; nothing
 *    from the river watch is published unchecked.
 * 2. Ponds through cloud: scan cells the optical scan could barely see (mining
 *    areas first) are compared with the same weeks two years earlier; new
 *    ponds of half a hectare or more become detections.
 */
const SLUG = "cdse-sentinel-1";
const DAY = 86_400_000;
const METHOD_PONDS = "s1-water-1.0";
const licence = "Copernicus Sentinel data, free and open (via Microsoft Planetary Computer)";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const sentinel1Adapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 12,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error("cdse-sentinel-1 needs the database");
    const budgetMs = num(process.env.S1_BUDGET_MINUTES, 30) * 60_000;
    const started = Date.now();
    const notes: string[] = [];
    const sas = await sasToken(ctx.fetchJson);

    // --- River watch -------------------------------------------------------
    if (!(await riverLinesFresh(db))) {
      try {
        await loadRiverLines(db, ctx.fetchText, ctx.log);
      } catch (e) {
        notes.push(`rivers: refresh failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const lines = await db.select().from(riverLines);
    const rivers: RiverLine[] = lines.filter((l) => l.kind === "river").map((l) => ({ name: l.name, coords: (l.geom as LineString).coordinates as [number, number][] }));
    const structures = lines.filter((l) => l.kind === "structure").map((l) => (l.geom as Point).coordinates as [number, number]);
    let flagged = 0;
    let targetsFound = 0;
    if (rivers.length) {
      const bbox: [number, number, number, number] = [
        Math.min(...lines.map((l) => l.bboxMinLon)),
        Math.min(...lines.map((l) => l.bboxMinLat)),
        Math.max(...lines.map((l) => l.bboxMaxLon)),
        Math.max(...lines.map((l) => l.bboxMaxLat)),
      ];
      const scenes = await searchRadar(ctx.fetchJson, { bbox }, new Date(ctx.now.getTime() - 14 * DAY), ctx.now);
      const done = new Set(
        scenes.length ? (await db.select({ id: radarScenes.id }).from(radarScenes).where(inArray(radarScenes.id, scenes.map((s) => s.id)))).map((r) => r.id) : [],
      );
      const todo = scenes.filter((s) => !done.has(s.id)).slice(0, num(process.env.S1_MAX_SCENES, 2));
      for (const scene of todo) {
        if (Date.now() - started > budgetMs / 2) break;
        const r = await riverWatch(ctx, scene, sas, rivers, structures);
        targetsFound += r.targets;
        flagged += r.flagged;
        ctx.log(`${SLUG}: river watch ${scene.id.slice(0, 32)} (${scene.datetime.slice(0, 10)}): ${r.windows} windows on the pass, ${r.open} with open water, ${r.targets} reflections, ${r.flagged} new dredger tags for review`);
      }
    } else notes.push("rivers: none loaded yet");

    // --- Ponds through cloud -----------------------------------------------
    const events: NormalisedEvent[] = [];
    // New ponds through cloud are part of the multi-sensor detector now (radar every month, every cell).
    if (detector() !== "legacy") return { events, notes, extra: { riverReflections: targetsFound, dredgerTagsForReview: flagged, radarPonds: 0, cells: 0 } };
    const maxCells = num(process.env.S1_MAX_CELLS, 40);
    const stale = new Date(ctx.now.getTime() - 6 * DAY);
    const cells = await db
      .select({ id: analysisCells.id, minLon: analysisCells.minLon, minLat: analysisCells.minLat, maxLon: analysisCells.maxLon, maxLat: analysisCells.maxLat, cov: analysisCells.coverageAfter, region: analysisCells.regionName })
      .from(analysisCells)
      .leftJoin(radarCells, eq(radarCells.cellId, analysisCells.id))
      .where(and(lt(analysisCells.coverageAfter, 40), or(isNull(radarCells.lastRunAt), lt(radarCells.lastRunAt, stale))))
      .orderBy(desc(analysisCells.priority), asc(analysisCells.coverageAfter))
      .limit(maxCells);
    let pondCount = 0;
    const water = new SurfaceWater();
    for (const cell of cells) {
      if (Date.now() - started > budgetMs) break;
      const bbox: [number, number, number, number] = [cell.minLon, cell.minLat, cell.maxLon, cell.maxLat];
      try {
        const res = await pondsInCell(ctx, cell.id, bbox, sas, water);
        pondCount += res.events.length;
        if (ctx.emit) await ctx.emit(res.events);
        else events.push(...res.events);
        ctx.log(`${SLUG}: cell ${cell.id} (${cell.region ?? ""}, optical cover ${cell.cov}%): ${res.events.length} new ponds by radar (${res.recent} recent, ${res.baseline} earlier passes)`);
      } catch (e) {
        notes.push(`cell ${cell.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { events, notes, extra: { riverReflections: targetsFound, dredgerTagsForReview: flagged, radarPonds: pondCount, cells: cells.length } };
  },
};

async function riverWatch(ctx: AdapterContext, scene: RadarScene, sas: string, rivers: RiverLine[], structuresLonLat: Array<[number, number]>) {
  const db = ctx.db!;
  const windows = riverWindows(rivers, scene.epsg);
  const structures = projectStructures(structuresLonLat, scene.epsg);
  const keys = [...windows.keys()];
  const found: RiverTarget[] = [];
  const skips = { outside: 0, "no-water": 0, rough: 0 };
  // A few windows at a time; neighbouring windows share file tiles, so keep them in order.
  for (let i = 0; i < keys.length; i += 4) {
    const batch = await Promise.all(
      keys.slice(i, i + 4).map((k) =>
        scanRiverWindow(scene, sas, k, windows.get(k)!, structures).catch(() => ({ targets: [] as RiverTarget[], skipped: "outside" as const })),
      ),
    );
    for (const b of batch) {
      found.push(...b.targets);
      if (b.skipped) skips[b.skipped]++;
    }
  }
  const acqDate = scene.datetime.slice(0, 10);
  const rows = found.map((t) => ({ id: uuidv7(), sceneId: scene.id, acqDate, lon: t.lon, lat: t.lat, vvDb: t.vvDb, vhDb: t.vhDb, river: t.river }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(radarTargets).values(rows.slice(i, i + 500)).onConflictDoNothing();

  // A reflection that repeats near the same spot on another day becomes a tag for a moderator.
  let flagged = 0;
  const near = 0.0012; // about 130 m
  for (const t of rows) {
    const from = new Date(new Date(acqDate).getTime() - 30 * DAY).toISOString().slice(0, 10);
    const to = new Date(new Date(acqDate).getTime() + 30 * DAY).toISOString().slice(0, 10);
    const repeats = await db
      .select({ id: radarTargets.id, acqDate: radarTargets.acqDate, vvDb: radarTargets.vvDb })
      .from(radarTargets)
      .where(
        and(
          ne(radarTargets.sceneId, scene.id),
          ne(radarTargets.acqDate, acqDate),
          gte(radarTargets.acqDate, from),
          lte(radarTargets.acqDate, to),
          gte(radarTargets.lon, t.lon - near),
          lte(radarTargets.lon, t.lon + near),
          gte(radarTargets.lat, t.lat - near),
          lte(radarTargets.lat, t.lat + near),
        ),
      )
      .limit(5);
    if (!repeats.length) continue;
    const since = new Date(ctx.now.getTime() - 60 * DAY);
    const yearAgo = new Date(ctx.now.getTime() - 365 * DAY);
    const existing = await db
      .select({ id: machinerySightings.id })
      .from(machinerySightings)
      .where(
        and(
          eq(machinerySightings.imagerySource, "sentinel-1"),
          or(gte(machinerySightings.createdAt, since), and(eq(machinerySightings.status, "rejected"), gte(machinerySightings.createdAt, yearAgo))),
          gte(machinerySightings.lon, t.lon - near),
          lte(machinerySightings.lon, t.lon + near),
          gte(machinerySightings.lat, t.lat - near),
          lte(machinerySightings.lat, t.lat + near),
        ),
      )
      .limit(1);
    if (existing.length) continue;
    const dates = [...new Set([acqDate, ...repeats.map((r) => r.acqDate)])].sort();
    const id = uuidv7();
    await db.insert(machinerySightings).values({
      id,
      kind: "dredger",
      count: 1,
      lon: t.lon,
      lat: t.lat,
      imagerySource: "sentinel-1",
      imageryRelease: null,
      imageryCapturedOn: acqDate,
      imagerySensor: `Sentinel-1 radar (${scene.platform})`,
      note: `Radar: strong reflection on open water of the ${t.river ?? "river"} on ${dates.join(", ")} (up to ${Math.max(t.vvDb, ...repeats.map((r) => r.vvDb)).toFixed(0)} dB VV, water around it below -15 dB). Could be a dredger or mining platform; also a boat, debris or a structure. Check the close-up and Google before confirming.`.slice(0, 280),
      status: "pending",
    });
    await db
      .update(radarTargets)
      .set({ sightingId: id })
      .where(inArray(radarTargets.id, [t.id, ...repeats.map((r) => r.id)]));
    flagged++;
  }
  await db
    .insert(radarScenes)
    .values({ id: scene.id, acquiredAt: new Date(scene.datetime), orbit: scene.orbit, riverTargets: rows.length, windows: keys.length, note: `${keys.length - skips.outside} windows on this pass: ${skips["no-water"]} showed no open water (narrow or tree-lined stretches), ${skips.rough} rough or mostly bank` })
    .onConflictDoNothing();
  return { windows: keys.length - skips.outside, open: keys.length - skips.outside - skips["no-water"] - skips.rough, targets: rows.length, flagged };
}

async function pondsInCell(ctx: AdapterContext, cellId: string, bbox: [number, number, number, number], sas: string, water: WaterSeen) {
  const db = ctx.db!;
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const recentAll = await searchRadar(ctx.fetchJson, { bbox }, new Date(ctx.now.getTime() - 48 * DAY), ctx.now);
  const twoYears = new Date(ctx.now.getTime() - 730 * DAY);
  const baselineAll = await searchRadar(ctx.fetchJson, { bbox }, new Date(twoYears.getTime() - 24 * DAY), new Date(twoYears.getTime() + 24 * DAY));
  const epsg = recentAll[0]?.epsg ?? epsgFor(centre[0]);
  // The same zone and, where possible, the same viewing direction, so the two periods compare like with like.
  const orbit = recentAll.filter((s) => s.epsg === epsg)[0]?.orbit;
  const pick = (list: RadarScene[], max: number) => {
    const same = list.filter((s) => s.epsg === epsg && s.orbit === orbit);
    return (same.length >= 2 ? same : list.filter((s) => s.epsg === epsg)).slice(0, max);
  };
  const recent = pick(recentAll, 5);
  const baseline = pick(baselineAll, 4);
  const record = async (ponds: number, coverage: number | null, note: string | null) =>
    db
      .insert(radarCells)
      .values({ cellId, lastRunAt: ctx.now, ponds, recentScenes: recent.length, baselineScenes: baseline.length, coverage, note })
      .onConflictDoUpdate({ target: radarCells.cellId, set: { lastRunAt: ctx.now, ponds, recentScenes: recent.length, baselineScenes: baseline.length, coverage, note } });
  if (recent.length < 2 || baseline.length < 2) {
    await record(0, null, "not enough radar passes");
    return { events: [] as NormalisedEvent[], recent: recent.length, baseline: baseline.length };
  }
  const { ponds, coverage } = await radarPonds(bbox, epsg, recent, baseline, sas, water);
  const events = mergeSameKey(ponds).map((p) => toPondEvent(p, recent, baseline));
  await record(events.length, Math.round(coverage * 100), null);
  return { events, recent: recent.length, baseline: baseline.length };
}

const pondKey = (p: RadarPond) => `rw-${p.centre.lon.toFixed(3)}-${p.centre.lat.toFixed(3)}`;

/** Ponds whose centres fall in the same ~100 m key become one detection, so none overwrites another. */
export function mergeSameKey(ponds: RadarPond[]): RadarPond[] {
  const byKey = new Map<string, RadarPond>();
  for (const p of [...ponds].sort((a, b) => b.areaHa - a.areaHa)) {
    const key = pondKey(p);
    const g = byKey.get(key);
    if (!g) byKey.set(key, p);
    else byKey.set(key, { ...g, pixels: g.pixels.concat(p.pixels), areaHa: g.areaHa + p.areaHa, ring: hull([...g.ring.slice(0, -1), ...p.ring.slice(0, -1)]) });
  }
  return [...byKey.values()];
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function toPondEvent(p: RadarPond, recent: RadarScene[], baseline: RadarScene[]): NormalisedEvent {
  const sourceEventId = pondKey(p);
  const id = stableId("event", `${SLUG}:${sourceEventId}`);
  const ha = Math.round(p.areaHa * 10) / 10;
  const newest = recent[0];
  const oldest = recent[recent.length - 1];
  const base = baseline[0];
  // Savannah north: seasonal flooding and rice fields can look like new ponds (same rule as the optical scan).
  const north = p.centre.lat > 8.0;
  const medium = !north && p.areaHa >= 2;
  return {
    sourceSlug: SLUG,
    sourceEventId,
    type: "water_change",
    detectedAt: new Date(newest.datetime),
    imageDate: oldest.datetime.slice(0, 10),
    imageDateEnd: newest.datetime.slice(0, 10),
    confidence: medium ? "medium" : "low",
    confidenceScore: medium ? 0.6 : 0.45,
    areaHa: ha,
    geom: { type: "Polygon", coordinates: [p.ring] },
    titleEn: `New ponds seen by radar, about ${ha} ha`,
    descriptionEn: `Sentinel-1 radar, which sees through cloud, shows open water here in ${recent.length} passes between ${fmt(oldest.datetime)} and ${fmt(newest.datetime)} that was not there in the same weeks two years earlier (${baseline.length} passes around ${fmt(base.datetime)}). Mining pits fill with water this way; new fish ponds, dams or flooded fields can look the same${north ? ", and in the savannah north seasonal flooding and rice fields often do" : ""}. Optical images could not see this area clearly because of cloud, so this comes from radar alone.`,
    methodVersion: METHOD_PONDS,
    properties: { radarPasses: recent.map((s) => s.id), baselinePasses: baseline.map((s) => s.id), pixels: p.pixels.length },
    images: [
      { role: "latest", sourceSlug: SLUG, productId: newest.id, sensor: `Sentinel-1 radar (${newest.platform})`, acquiredAt: new Date(newest.datetime), thumbnailUrl: `/api/v1/events/${id}/image?role=latest`, tileUrlTemplate: newest.vv, licence },
      { role: "before", sourceSlug: SLUG, productId: base.id, sensor: `Sentinel-1 radar (${base.platform})`, acquiredAt: new Date(base.datetime), thumbnailUrl: `/api/v1/events/${id}/image?role=before`, tileUrlTemplate: base.vv, licence },
    ],
  };
}

