import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Handover from the two-date scan (2.x) to the multi-sensor tracker (3.0), cell by cell, through the
 * database: a cell is handed over only once its tracker record reaches the present; then 2.x pits and radar
 * ponds there are superseded, cleared land inside a 3.0 mining site is hidden, and muddy rivers and cleared
 * land elsewhere in the cell stay, so the cleared-land and river functions keep working.
 */
mkdirSync(".data-pgtest", { recursive: true });
const dir = mkdtempSync(join(".data-pgtest", "handover-"));
process.env.DATA_DIR = join(dir, "data");
process.env.GW_TS_DIR = join(dir, "ts");
process.env.GW_MODEL_DIR = join(dir, "models");
delete process.env.GW_DETECTOR;
delete process.env.DATABASE_URL;
mkdirSync(process.env.GW_MODEL_DIR, { recursive: true });

describe("2.x to 3.0 handover", () => {
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

  it("hands a cell over only when its record is current and the model is present", async () => {
    const { handedOver, stateLastMonth, HANDOVER_SLACK } = await import("@/pipeline/ts/handover");
    const { saveState } = await import("@/pipeline/ts/cell");
    const { newState, monthIndex } = await import("@/pipeline/ts/tracker");
    const now = new Date("2026-10-30T08:00:00Z");
    expect(stateLastMonth("hcell")).toBe(-1);
    const s = newState(1000);
    s.firstMonth = monthIndex("2017-01");
    s.lastMonth = monthIndex("2026-09") - HANDOVER_SLACK - 1;
    saveState("hcell", s);
    expect(stateLastMonth("hcell")).toBe(s.lastMonth);
    // Not enabled on this machine: the legacy detector runs everywhere.
    expect(handedOver("hcell", now)).toBe(false);
    process.env.GW_DETECTOR = "multisensor";
    // No model files yet: still the legacy detector.
    expect(handedOver("hcell", now)).toBe(false);
    writeFileSync(join(process.env.GW_MODEL_DIR!, "gw_mining_unet.onnx"), "x");
    writeFileSync(join(process.env.GW_MODEL_DIR!, "gw_mining_unet.json"), "{}");
    expect(handedOver("hcell", now)).toBe(false); // still catching up
    s.lastMonth = monthIndex("2026-09") - HANDOVER_SLACK;
    saveState("hcell", s);
    expect(handedOver("hcell", now)).toBe(true);
    process.env.GW_DETECTOR = "legacy";
    expect(handedOver("hcell", now)).toBe(false);
    delete process.env.GW_DETECTOR;
    expect(handedOver("hcell", now)).toBe(false);
  });

  it("supersedes 2.x galamsey but keeps rivers and cleared land outside mining sites", async () => {
    const { changeEvents } = await import("@/lib/db/schema");
    const { seedSources, sourceId } = await import("@/pipeline/seed/sources");
    const { stableId } = await import("@/lib/server/ids");
    const { supersedeLegacy, METHOD } = await import("@/pipeline/adapters/timeseries");
    const { eq } = await import("drizzle-orm");
    await seedSources(db, () => undefined);
    const cell = { id: "hcell", regionName: "Western Region", minLon: -2.0, minLat: 5.2, maxLon: -1.8, maxLat: 5.4, priority: 2 };
    const box = (lon: number, lat: number, d: number) => ({
      geom: { type: "Polygon" as const, coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] },
      bboxMinLon: lon, bboxMinLat: lat, bboxMaxLon: lon + d, bboxMaxLat: lat + d, centroidLon: lon + d / 2, centroidLat: lat + d / 2,
    });
    const ev = (key: string, src: string, method: string, type: string, signature: string, g: ReturnType<typeof box>) => ({
      id: stableId("event", key), sourceId: sourceId(src), sourceEventId: key, type, detectedAt: new Date(), imageDate: "2026-09-15",
      confidence: "medium", severity: "watch", areaHa: 3, titleEn: key, methodVersion: method,
      properties: { signature, cell: cell.id }, ...g,
    });
    await db.insert(changeEvents).values([
      ev("site", "gw-multisensor", METHOD, "surface_disturbance", "mining", box(-1.95, 5.25, 0.01)),
      ev("pits", "cdse-sentinel-2", "s2-galamsey-2.2", "surface_disturbance", "new_pits", box(-1.9, 5.3, 0.002)),
      ev("clearedIn", "cdse-sentinel-2", "s2-galamsey-2.2", "surface_disturbance", "cleared", box(-1.948, 5.252, 0.004)),
      ev("clearedOut", "cdse-sentinel-2", "s2-galamsey-2.2", "surface_disturbance", "cleared", box(-1.85, 5.35, 0.004)),
      ev("river", "cdse-sentinel-2", "s2-galamsey-2.2", "water_change", "turbid_water", box(-1.88, 5.22, 0.004)),
      ev("pond", "cdse-sentinel-1", "s1-water-1.0", "surface_disturbance", "radar_pond", box(-1.83, 5.21, 0.002)),
    ]);
    await supersedeLegacy(db, cell);
    const status = async (key: string) => (await db.select({ s: changeEvents.status, p: changeEvents.properties }).from(changeEvents).where(eq(changeEvents.sourceEventId, key)))[0];
    expect((await status("site")).s).toBe("new");
    expect((await status("pits")).s).toBe("dismissed");
    expect((await status("pits")).p.supersededBy).toBe(METHOD);
    expect((await status("pond")).s).toBe("dismissed");
    expect((await status("clearedIn")).s).toBe("dismissed");
    expect((await status("clearedIn")).p.autoDismissed).toBeTruthy();
    expect((await status("clearedOut")).s).toBe("new");
    expect((await status("river")).s).toBe("new");
  }, 120_000);

  it("measures how much of a cleared outline lies in a mining site", async () => {
    const { coveredShare } = await import("@/pipeline/ts/handover");
    expect(coveredShare([0, 0, 1, 1], [[0.5, 0, 2, 1]])).toBeCloseTo(0.5);
    expect(coveredShare([0, 0, 1, 1], [[2, 2, 3, 3]])).toBe(0);
    expect(coveredShare([0.2, 0.2, 0.4, 0.4], [[0, 0, 1, 1]])).toBe(1);
  });
});
