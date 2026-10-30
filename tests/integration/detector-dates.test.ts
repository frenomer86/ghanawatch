import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * "First seen" for the multi-sensor record is the month the record first confirmed a site, not its onset (when
 * mining began, usually months earlier) and not the day a cell's detections were first published. Checked
 * through the database for the weekly digest, the district cards and the monthly confirmation sample:
 *  K1 confirmed last month and published now: new (digest), first seen last month (cards), in last month's sample;
 *  K2 confirmed in 2021, published now because its cell was handed over: not new anywhere;
 *  K3 published now from the month in progress, no history row yet: new (digest and cards).
 */
mkdirSync(".data-pgtest", { recursive: true });
const dir = mkdtempSync(join(".data-pgtest", "dates-"));
process.env.DATA_DIR = join(dir, "data");
delete process.env.DATABASE_URL;

describe("first seen, multi-sensor record", () => {
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

  it("digest, district cards and the confirmation sample count a site when its record confirmed it", async () => {
    const { adminBoundaries, changeEvents, historyEvents } = await import("@/lib/db/schema");
    const { seedSources, sourceId } = await import("@/pipeline/seed/sources");
    const { stableId } = await import("@/lib/server/ids");
    const { buildDigest } = await import("@/lib/server/alerts/digest");
    const { loadEvents } = await import("@/lib/db/repo/scorecards");
    const { ensureSample } = await import("@/lib/server/release/run");
    const { sql } = await import("drizzle-orm");
    await seedSources(db, () => undefined);
    const ring: [number, number][] = [[-2.1, 5.1], [-1.8, 5.1], [-1.8, 5.4], [-2.1, 5.4], [-2.1, 5.1]];
    const districtId = stableId("boundary", "dates-district");
    await db.insert(adminBoundaries).values({
      id: districtId, level: "district", code: "DATES-D", name: "Dates District", areaKm2: 100,
      geom: { type: "Polygon", coordinates: [ring] }, bboxMinLon: -2.1, bboxMinLat: 5.1, bboxMaxLon: -1.8, bboxMaxLat: 5.4, centroidLon: -1.95, centroidLat: 5.25,
    });
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const spot = (lon: number, lat: number) => ({
      geom: { type: "Point" as const, coordinates: [lon, lat] }, bboxMinLon: lon, bboxMinLat: lat, bboxMaxLon: lon, bboxMaxLat: lat, centroidLon: lon, centroidLat: lat, districtId,
    });
    const site = (key: string, onset: string, lon: number) => ({
      id: stableId("event", key), sourceId: sourceId("gw-multisensor"), sourceEventId: key, type: "surface_disturbance", detectedAt: now, imageDate: now.toISOString().slice(0, 10),
      firstImageDate: onset, confidence: "high", severity: "watch", areaHa: 5, titleEn: key, methodVersion: "s2-galamsey-3.0",
      properties: { signature: "mining", placement: {} }, createdAt: now, ...spot(lon, 5.2),
    });
    await db.insert(changeEvents).values([site("K1", "2026-01-01", -2.0), site("K2", "2020-06-01", -1.95), site("K3", "2026-03-01", -1.9)]);
    const cohort = (key: string, month: string, lon: number) => ({
      id: stableId("history", `${month}:${key}`), scanMonth: month, sourceEventId: key, type: "surface_disturbance", imageDate: `${month}-28`, confidence: "high", severity: "normal",
      areaHa: 5, methodVersion: "s2-galamsey-3.0", properties: { signature: "mining", cohort: true, siteKey: key }, ...spot(lon, 5.2),
    });
    await db.insert(historyEvents).values([cohort("K1", lastMonth, -2.0), cohort("K2", "2021-03", -1.95), cohort("K2", "2021-04", -1.95)]);

    const digest = await buildDigest(new Date(now.getTime() + 86_400_000));
    expect(digest.districts.flatMap((d) => d.sites.map((s) => s.title)).sort()).toEqual(["K1", "K3"]);

    const cards = await loadEvents();
    const firstSeen = cards.map((c) => c.firstSeen.toISOString().slice(0, 10)).sort();
    expect(firstSeen).toEqual(["2021-03-01", `${lastMonth}-01`, now.toISOString().slice(0, 10)].sort());

    await ensureSample(lastMonth, () => undefined);
    const picked = (await db.execute(sql`select e.source_event_id as key from confirmation_samples s join change_events e on e.id = s.change_event_id where s.month = ${lastMonth}`)) as unknown;
    const { rows } = await import("@/lib/db/client");
    expect(rows<{ key: string }>(picked).map((r) => r.key)).toEqual(["K1"]);
  }, 120_000);
});
