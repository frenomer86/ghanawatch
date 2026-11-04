import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PhotoScreen } from "@/lib/server/reports/image-safety";
import type { SatelliteCheck } from "@/lib/domain/cases";

/**
 * Citizen reports checked with no moderator, end to end on a real (embedded) database: the upload route reads
 * the photo's own GPS position and time before stripping them and removes phone numbers from the text; the
 * reviewer then screens the photo, blurs faces, and publishes, rejects, holds or closes each report on the
 * evidence, never overriding a moderator. The photo screen and the satellite comparison are replaced by fakes
 * (both have their own tests); everything else is the production code.
 */
mkdirSync(".data-pgtest", { recursive: true });
const dir = mkdtempSync(join(".data-pgtest", "review-"));
process.env.DATA_DIR = join(dir, "data");
delete process.env.DATABASE_URL;
vi.mock("@/lib/server/explore/wayback", () => ({ highResCaptures: async () => [] }));
// after() needs a live request scope; here the deferred work simply runs at once.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));

const DISTRICT = "0190e000-0000-7000-8000-000000000001";
const fx = (f: string) => readFileSync(join(process.cwd(), "tests/fixtures/exif", f));
let ipSeq = 0;

const screenAs =
  (nsfw: number | null, faces = 0) =>
  async (image: Buffer): Promise<PhotoScreen> => ({
    nsfw,
    faces: Array.from({ length: faces }, () => ({ x: 1, y: 1, w: 10, h: 10, score: 0.9 })),
    blurred: faces ? Buffer.concat([Buffer.from("BLURRED"), image.subarray(0, 16)]) : null,
    width: 64,
    height: 48,
  });
const noSatellite = async (): Promise<SatelliteCheck> => ({ checkedAt: new Date().toISOString(), radiusM: 750, suggestion: "not_visible_yet", detections: [], closeUp: null });

describe("automatic report checking", () => {
  let db: Awaited<ReturnType<typeof import("@/lib/db/client").getDb>>;
  let S: typeof import("@/lib/db/schema");
  let R: typeof import("@/lib/server/reports/auto-review");
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    const { getDb } = await import("@/lib/db/client");
    db = await getDb();
    S = await import("@/lib/db/schema");
    R = await import("@/lib/server/reports/auto-review");
    eq = (await import("drizzle-orm")).eq;
    await db.insert(S.adminBoundaries).values({
      id: DISTRICT,
      level: "district",
      code: "TEST-DISTRICT",
      name: "Test District",
      bboxMinLon: -2.5,
      bboxMaxLon: -1,
      bboxMinLat: 5,
      bboxMaxLat: 7.5,
      geom: { type: "Polygon", coordinates: [[[-2.5, 5], [-1, 5], [-1, 7.5], [-2.5, 7.5], [-2.5, 5]]] },
    });
  }, 120_000);
  afterAll(async () => {
    const { closeDb } = await import("@/lib/db/client");
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (id: string) => (await db.select().from(S.communityReports).where(eq(S.communityReports.id, id)))[0];

  /** A report as the upload route stores it, without going through HTTP. */
  const insert = async (over: Partial<typeof import("@/lib/db/schema").communityReports.$inferInsert> & { photo?: Buffer }) => {
    const { uuidv7 } = await import("@/lib/server/ids");
    const { putObject } = await import("@/lib/server/storage");
    const id = uuidv7();
    const photo = over.photo ?? Buffer.from(`photo-${id}`);
    const stored = await putObject(`reports/${id.slice(0, 4)}/${id}.webp`, photo, "image/webp");
    const rest = { ...over };
    delete rest.photo;
    await db.insert(S.communityReports).values({
      id,
      lat: 6.2,
      lon: -1.9,
      description: "Pits and a washing plant by the river",
      category: "galamsey",
      photoKey: stored.key,
      photoSha256: `sha-${id}`,
      status: "pending",
      caseStatus: "reported",
      submittedIpHash: `ip-${ipSeq++}`,
      districtId: DISTRICT,
      ...rest,
    });
    return id;
  };

  it("reads the photo's GPS position and time at upload, strips them from the stored photo and removes phone numbers", async () => {
    const { POST } = await import("@/app/api/v1/reports/route");
    const fd = new FormData();
    fd.set("photo", new File([fx("gps.jpg")], "p.jpg", { type: "image/jpeg" }));
    fd.set("lat", "6.6913");
    fd.set("lon", "-1.6201");
    fd.set("description", "Excavators in the stream. Call 024 123 4567 or mail kofi@example.com");
    fd.set("category", "galamsey");
    fd.set("locationSource", "pin");
    const res = await POST(new NextRequest("http://localhost:3000/api/v1/reports", { method: "POST", body: fd, headers: { origin: "http://localhost:3000", "x-forwarded-for": "203.0.113.7" } }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await get(id);
    expect(row.photoMeta).toEqual({ lat: 6.690167, lon: -1.620083, accuracyM: 8, takenAt: "2026-10-28T09:15:30.000Z" });
    expect(row.locationSource).toBe("pin"); // 126 m from the photo's position: the reporter's own pin
    expect(row.description).toBe("Excavators in the stream. Call [number removed] or mail [email removed]");
    const { readObject } = await import("@/lib/server/storage");
    const { readPhotoMeta } = await import("@/lib/domain/exif");
    expect(readPhotoMeta((await readObject(row.photoKey!))!).lat).toBeNull();

    // The reviewer: the photo's own position is 126 m away and it was taken a day before the report.
    await db.update(S.communityReports).set({ observedAt: new Date("2026-10-29T09:00:00Z") }).where(eq(S.communityReports.id, id));
    expect(await R.reviewReport(await get(id), new Date(), { screen: screenAs(0.01, 1), satellite: noSatellite })).toBe("approve");
    const done = await get(id);
    expect(done.status).toBe("approved");
    expect(done.moderatorId).toBeNull();
    expect(done.caseStatus).toBe("confirmed");
    expect(done.satelliteVerdict).toBe("not_visible_yet");
    expect((done.autoReview as { reasons: string[] }).reasons).toEqual(["photo_matches"]);
    expect(String((await readObject(done.photoKey!))!.subarray(0, 7))).toBe("BLURRED");
    const trail = await db.select().from(S.reportCaseEvents).where(eq(S.reportCaseEvents.reportId, id));
    expect(trail.map((e) => e.caseStatus)).toEqual(["reported", "confirmed"]);
    expect(trail[1].note).toMatch(/^Checked automatically: the photo's own GPS position is 12\d m from this spot and it was taken on 28 Oct 2026\.$/);
    expect(trail[1].actorId).toBeNull();
    const audit = await db.select().from(S.auditLog).where(eq(S.auditLog.entityId, id));
    expect(audit.map((a) => a.action)).toEqual(["report_auto_approve"]);
  });

  it("rejects an unsafe photo and deletes it", async () => {
    const id = await insert({});
    const key = (await get(id)).photoKey!;
    expect(await R.reviewReport(await get(id), new Date(), { screen: screenAs(0.97), satellite: noSatellite })).toBe("reject");
    const row = await get(id);
    expect(row.status).toBe("rejected");
    expect(row.photoKey).toBeNull();
    const { readObject } = await import("@/lib/server/storage");
    expect(await readObject(key)).toBeNull();
  });

  it("rejects a photo already used for a report of somewhere else", async () => {
    const first = await insert({ photoSha256: "same-photo" });
    const second = await insert({ photoSha256: "same-photo", lat: 9.4, lon: -0.85 });
    expect(await R.reviewReport(await get(second), new Date(), { screen: screenAs(0.01), satellite: noSatellite })).toBe("reject");
    expect((await get(second)).autoReview).toMatchObject({ reasons: ["photo_reused"] });
    expect((await get(first)).status).toBe("pending");
  });

  it("publishes a fire report when a satellite saw a fire within 2 km and three days", async () => {
    const id = await insert({ category: "fire", lat: 7.1, lon: -1.4, observedAt: new Date("2026-11-02T15:00:00Z") });
    await db.insert(S.firePoints).values({ lon: -1.41, lat: 7.105, acqDate: "2026-11-01", acqTime: "1310", confidence: "h", source: "VIIRS_NOAA20_NRT" });
    expect(await R.reviewReport(await get(id), new Date(), { screen: screenAs(0.02), satellite: noSatellite })).toBe("approve");
    const row = await get(id);
    expect(row.satelliteVerdict).toBe("confirmed_by_satellite");
    expect(row.autoReview).toMatchObject({ reasons: ["corroborated"], evidence: [{ kind: "fire_hotspot", date: "2026-11-01" }] });
  });

  it("publishes a flood report after heavy rain over its district", async () => {
    const id = await insert({ category: "flooding", lat: 5.9, lon: -2.1, observedAt: new Date("2026-11-03T08:00:00Z") });
    await db.insert(S.districtRain).values({ districtId: DISTRICT, day: "2026-11-02", rainMm: 82, rainHours: 9, maxHourlyMm: 31 });
    expect(await R.reviewReport(await get(id), new Date(), { screen: screenAs(0.02), satellite: noSatellite })).toBe("approve");
    expect((await get(id)).autoReview).toMatchObject({ evidence: [{ kind: "heavy_rain", date: "2026-11-02", rainMm: 82 }] });
  });

  it("publishes two independent reports of the same thing at the same place", async () => {
    const a = await insert({ category: "dumping", lat: 5.61, lon: -0.2 });
    const b = await insert({ category: "dumping", lat: 5.613, lon: -0.2 });
    expect(await R.reviewReport(await get(a), new Date(), { screen: screenAs(0.02), satellite: noSatellite })).toBe("approve");
    expect(await R.reviewReport(await get(b), new Date(), { screen: screenAs(0.02), satellite: noSatellite })).toBe("approve");
    expect((await get(b)).autoReview).toMatchObject({ evidence: [{ kind: "other_reports", count: 1 }] });
  });

  it("holds a report with no evidence, comes back when due, and publishes once a satellite detection appears", async () => {
    const id = await insert({ category: "galamsey", lat: 6.05, lon: -2.3 });
    const t0 = new Date();
    expect(await R.reviewReport(await get(id), t0, { screen: screenAs(0.02), satellite: noSatellite })).toBe("hold");
    const held = (await get(id)).autoReview as { nextCheckAt: string; checks: number };
    expect(Date.parse(held.nextCheckAt) - t0.getTime()).toBe(3 * 3_600_000);

    // Not due an hour later; due after three hours, when a detection has arrived.
    await R.reviewDue(new Date(t0.getTime() + 3_600_000), { deps: { screen: screenAs(0.02), satellite: noSatellite } });
    expect((await get(id)).autoReview).toMatchObject({ decision: "hold", checks: 1 });
    const detection = async (): Promise<SatelliteCheck> => ({
      ...(await noSatellite()),
      suggestion: "confirmed_by_satellite",
      detections: [{ id: "0190e000-0000-7000-8000-0000000000aa", type: "surface_disturbance", title: "New pits beside the Ankobra", severity: "elevated", imageDate: "2026-11-03", distanceM: 280 }],
    });
    const later = new Date(t0.getTime() + 3 * 3_600_000 + 1000);
    await R.reviewDue(later, { deps: { screen: screenAs(0.02), satellite: detection } });
    const row = await get(id);
    expect(row.status).toBe("approved");
    expect(row.satelliteVerdict).toBe("confirmed_by_satellite");
    expect(row.autoReview).toMatchObject({ decision: "approve", checks: 2 });
  });

  it("closes a report as unverified after 30 days with nothing to confirm it", async () => {
    const id = await insert({ category: "other", lat: 10.5, lon: -0.5, submittedIpHash: null });
    const t0 = new Date();
    await R.reviewReport(await get(id), t0, { screen: screenAs(0.02), satellite: noSatellite });
    expect(await R.reviewReport(await get(id), new Date(t0.getTime() + 31 * 86_400_000), { satellite: noSatellite })).toBe("expire");
    expect((await get(id)).status).toBe("unverified");
  });

  it("never overrides a moderator who decided first", async () => {
    const id = await insert({});
    const stale = await get(id);
    await db.update(S.communityReports).set({ status: "rejected", moderatedAt: new Date() }).where(eq(S.communityReports.id, id));
    expect(await R.reviewReport(stale, new Date(), { screen: screenAs(0.01, 0), satellite: async () => ({ ...(await noSatellite()), detections: [{ id: "x", type: "surface_disturbance", title: "t", severity: "watch", imageDate: "2026-11-01", distanceM: 10 }] }) })).toBe("skipped");
    expect((await get(id)).status).toBe("rejected");
  });
});
