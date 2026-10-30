import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End to end through the database, without the network: tracker months -> history rows (writeHistory)
 * -> loadSites -> Galamsey Index 2.0. A site appears, is confirmed, then spreads; the index must count
 * its first ground in the month it was confirmed and the spread in the month the spread was confirmed.
 */
// The database client puts DATA_DIR under the project folder; .data-pgtest/ is git-ignored.
mkdirSync(".data-pgtest", { recursive: true });
const dir = mkdtempSync(join(".data-pgtest", "detector-"));
process.env.DATA_DIR = join(dir, "data");
process.env.GW_TS_DIR = join(dir, "ts");
delete process.env.DATABASE_URL;

describe("detector 3.0 history rows feed Galamsey Index 2.0", () => {
  let mod: {
    db: Awaited<ReturnType<typeof import("@/lib/db/client").getDb>>;
  };
  beforeAll(async () => {
    const { getDb } = await import("@/lib/db/client");
    mod = { db: await getDb() };
  }, 120_000);
  afterAll(async () => {
    const { closeDb } = await import("@/lib/db/client");
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts new ground and its spread in the months they were confirmed", async () => {
    const { adminBoundaries } = await import("@/lib/db/schema");
    const { stableId } = await import("@/lib/server/ids");
    const { cellLayout, STATE_RES } = await import("@/pipeline/ts/cell");
    const { newState, step, monthIndex } = await import("@/pipeline/ts/tracker");
    const { extractSites } = await import("@/pipeline/ts/sites");
    const { writeHistory } = await import("@/pipeline/adapters/timeseries");
    const { DistrictIndex, loadDistricts } = await import("@/pipeline/districts");
    const { ContextIndex } = await import("@/pipeline/context/annotate");
    const { loadSites } = await import("@/lib/server/index/sightings");
    const { buildIndex } = await import("@/lib/domain/index");
    const db = mod.db;

    const ring: [number, number][] = [[-2.1, 5.1], [-1.8, 5.1], [-1.8, 5.4], [-2.1, 5.4], [-2.1, 5.1]];
    await db.insert(adminBoundaries).values({
      id: stableId("boundary", "test-district"), level: "district", code: "TEST-D", name: "Test District", areaKm2: 100,
      geom: { type: "Polygon", coordinates: [ring] }, bboxMinLon: -2.1, bboxMinLat: 5.1, bboxMaxLon: -1.8, bboxMaxLat: 5.4, centroidLon: -1.95, centroidLat: 5.25,
    });
    const districts = new DistrictIndex(await loadDistricts(db));
    const context = await ContextIndex.load(db);

    const cell = { id: "ctest", regionName: "Western Region", minLon: -2.0, minLat: 5.2, maxLon: -1.98, maxLat: 5.22, priority: 1 };
    const layout = cellLayout(cell);
    const W = layout.state.width, H = layout.state.height, n = W * H;
    const state = newState(n);
    const A: number[] = [], B: number[] = [];
    for (let y = 40; y < 50; y++) for (let x = 40; x < 50; x++) A.push(y * W + x); // 100 px = 4 ha
    for (let y = 40; y < 50; y++) for (let x = 50; x < 55; x++) B.push(y * W + x); // 50 px = 2 ha, next to A
    const months = ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05"];
    months.forEach(() => undefined);
    for (const [k, m] of months.entries()) {
      const prob = new Float32Array(n).fill(0.02);
      if (k >= 1) for (const i of A) prob[i] = 0.95;
      if (k >= 2) for (const i of B) prob[i] = 0.95;
      const before = Int16Array.from(state.onset);
      step(state, monthIndex(m), prob, new Uint8Array(n).fill(1));
      const sites = extractSites(state, W, H, STATE_RES, before);
      await writeHistory(db, { cell, month: m, layout, state, sites, coverage: { sentinel2: 1, landsat: 0, radar: 0, none: 0 }, scenes: { s2: [], landsat: [], s1: [] } }, districts, context);
    }

    const { sites, legacyFallback } = await loadSites();
    expect(legacyFallback).toBe(false);
    expect(sites).toHaveLength(1);
    const idx = buildIndex(sites, [{ id: stableId("boundary", "test-district"), name: "Test District", region: null, areaKm2: 100 }], months);
    const byMonth = Object.fromEntries(idx.national.map((r) => [r.month, r.newHa]));
    // A looks mined from February and is confirmed in March; B from March, confirmed in April.
    expect(byMonth["2021-02"]).toBe(0);
    expect(byMonth["2021-03"]).toBeCloseTo(4, 1);
    expect(byMonth["2021-04"]).toBeCloseTo(2, 1);
    expect(byMonth["2021-05"]).toBe(0);
    expect(idx.national.at(-1)!.cumHa).toBeCloseTo(6, 1);
    expect(idx.national.find((r) => r.month === "2021-03")!.newSites).toBe(1);
    expect(idx.national.find((r) => r.month === "2021-04")!.newSites).toBe(0);
  }, 120_000);
});
