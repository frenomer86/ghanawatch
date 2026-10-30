import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FloodPatch } from "@/pipeline/s1/flood";
import type { RadarScene } from "@/pipeline/s1/pc";

/**
 * Flooding seen by radar: which forecasts and reports trigger a radar look, how passes and near-duplicate
 * triggers are grouped, which outlines are dropped as mining ponds, and that a flood report inside an outline
 * is confirmed by the satellite check however far it is from the outline's centre.
 */
mkdirSync(".data-pgtest", { recursive: true });
const dir = mkdtempSync(join(".data-pgtest", "flood-"));
process.env.DATA_DIR = join(dir, "data");
process.env.S1_FLOOD_DIR = join(dir, "s1-flood");
delete process.env.DATABASE_URL;
vi.mock("@/lib/server/explore/wayback", () => ({ highResCaptures: async () => [] }));

const patch = (lon: number, lat: number, ha: number, d = 0.01): FloodPatch => ({
  areaHa: ha,
  centre: { lon, lat },
  geom: { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] },
});

describe("radar flood outlines", () => {
  let db: Awaited<ReturnType<typeof import("@/lib/db/client").getDb>>;
  beforeAll(async () => {
    const { getDb } = await import("@/lib/db/client");
    db = await getDb();
  }, 120_000);
  afterAll(async () => {
    const { closeDb } = await import("@/lib/db/client");
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groups radar items into passes and drops near-duplicate triggers", async () => {
    const { groupPasses, selectTriggers } = await import("@/pipeline/adapters/radar-flood");
    const sc = (id: string, datetime: string, orbit: "ascending" | "descending"): RadarScene => ({ id, datetime, orbit, platform: "SENTINEL-1C", epsg: 32630, vv: id, vh: id });
    const passes = groupPasses([sc("b", "2026-09-12T18:10:00Z", "ascending"), sc("a", "2026-09-12T18:09:30Z", "ascending"), sc("c", "2026-09-06T06:00:00Z", "descending")]);
    expect(passes.map((p) => [p.date, p.scenes.length])).toEqual([["2026-09-06", 1], ["2026-09-12", 2]]);
    const t = (key: string, lon: number, lat: number, date: string, priority: number) => ({ key, kind: "rain-forecast" as const, place: key, lon, lat, date, priority });
    const chosen = selectTriggers([t("rain", -1.62, 6.7, "2026-09-10", 1), t("report", -1.6, 6.68, "2026-09-11", 3), t("far", -0.2, 5.6, "2026-09-10", 1)]);
    expect(chosen.map((x) => x.key)).toEqual(["report", "far"]);
  });

  it("drops outlines inside known mining sites and grades the rest by area", async () => {
    const { dropMining, floodSeverity, toEvent } = await import("@/pipeline/adapters/radar-flood");
    const kept = dropMining([patch(-1.9, 5.5, 30), patch(-1.7, 5.6, 300)], [[-1.905, 5.495, -1.895, 5.505]]);
    expect(kept).toHaveLength(1);
    expect(floodSeverity(9)).toBe("watch");
    expect(floodSeverity(150)).toBe("elevated");
    expect(floodSeverity(800)).toBe("urgent");
    const ev = toEvent({ key: "report:x", kind: "report", place: "a public flood report", lon: -1.7, lat: 5.6, date: "2026-09-10", priority: 3 }, "2026-09-12-SENTINEL-1C-ascending", "2026-09-12", kept[0], 420, 0.95, 4, new Date("2026-09-13T00:00:00Z"));
    expect(ev.type).toBe("flood_risk");
    expect(ev.properties?.signature).toBe("radar_flood");
    expect(ev.sourceEventId).toBe("2026-09-12-SENTINEL-1C-ascending--1.700-5.600");
    expect(ev.confidence).toBe("high");
    expect(ev.severity).toBe("elevated");
  });

  it("finds forecasts and approved reports to check, and confirms a flood report inside an outline", async () => {
    const { changeEvents, communityReports } = await import("@/lib/db/schema");
    const { seedSources, sourceId } = await import("@/pipeline/seed/sources");
    const { stableId, uuidv7 } = await import("@/lib/server/ids");
    const { loadTriggers, toEvent } = await import("@/pipeline/adapters/radar-flood");
    const { satelliteCheck } = await import("@/lib/server/reports/satellite-check");
    await seedSources(db, () => undefined);
    const now = new Date("2026-09-14T09:00:00Z");
    const pt = (lon: number, lat: number) => ({ geom: { type: "Point" as const, coordinates: [lon, lat] }, bboxMinLon: lon, bboxMinLat: lat, bboxMaxLon: lon, bboxMaxLat: lat, centroidLon: lon, centroidLat: lat });
    await db.insert(changeEvents).values([
      { id: stableId("event", "glofas"), sourceId: sourceId("copernicus-glofas"), sourceEventId: "g1", type: "flood_risk", detectedAt: now, imageDate: "2026-09-08", imageDateEnd: "2026-09-10", confidence: "high", severity: "elevated", titleEn: "Flood risk on the Pra", methodVersion: "glofas-openmeteo-1.0", properties: { river: "Pra" }, ...pt(-1.62, 5.4) },
      { id: stableId("event", "rain-watch"), sourceId: sourceId("open-meteo"), sourceEventId: "r1", type: "flood_risk", detectedAt: now, imageDate: "2026-09-11", confidence: "medium", severity: "watch", titleEn: "Heavy rain", methodVersion: "rain-forecast-1.0", properties: { district: "Kumasi" }, ...pt(-1.6, 6.7) },
      { id: stableId("event", "rain-old"), sourceId: sourceId("open-meteo"), sourceEventId: "r2", type: "flood_risk", detectedAt: now, imageDate: "2026-08-01", confidence: "medium", severity: "urgent", titleEn: "Old rain", methodVersion: "rain-forecast-1.0", properties: { district: "Accra" }, ...pt(-0.2, 5.6) },
    ]);
    await db.insert(communityReports).values({ id: uuidv7(), lat: 5.62, lon: -0.25, description: "Our street is under water", category: "flooding", status: "approved", createdAt: new Date("2026-09-12T10:00:00Z") });
    const triggers = await loadTriggers(db, now);
    expect(triggers.map((t) => [t.kind, t.place, t.date]).sort()).toEqual([
      ["report", "a public flood report", "2026-09-12"],
      ["river-forecast", "the Pra", "2026-09-10"],
    ]);

    // An outline 3 km across; the report point is 1.2 km from its centre, inside it.
    const ev = toEvent(triggers[0], "2026-09-13-SENTINEL-1C-descending", "2026-09-13", patch(-0.24, 5.63, 900, 0.015), 900, 0.9, 4, now);
    const { bboxOf, centroidOf } = await import("@/lib/geo");
    const b = bboxOf(ev.geom);
    const c = centroidOf(ev.geom);
    await db.insert(changeEvents).values({
      id: stableId("event", ev.sourceEventId), sourceId: sourceId("s1-flood"), sourceEventId: ev.sourceEventId, type: ev.type, detectedAt: now, imageDate: ev.imageDate,
      confidence: ev.confidence, severity: ev.severity!, areaHa: ev.areaHa, titleEn: ev.titleEn, methodVersion: ev.methodVersion, properties: ev.properties ?? {},
      geom: ev.geom, bboxMinLon: b[0], bboxMinLat: b[1], bboxMaxLon: b[2], bboxMaxLat: b[3], centroidLon: c.lon, centroidLat: c.lat,
    });
    const check = await satelliteCheck(-0.25, 5.62, "flooding", now);
    expect(check.suggestion).toBe("confirmed_by_satellite");
    expect(check.detections[0]).toMatchObject({ distanceM: 0, type: "flood_risk" });
    const outside = await satelliteCheck(-0.3, 5.7, "flooding", now);
    expect(outside.detections).toHaveLength(0);
  }, 120_000);
});
