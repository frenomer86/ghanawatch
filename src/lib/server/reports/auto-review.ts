import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { auditLog, changeEvents, communityReports, districtRain, firePoints } from "@/lib/db/schema";
import { addCaseEvent, saveSatelliteCheck } from "@/lib/db/repo/cases";
import {
  decide,
  moderationNote,
  publicNote,
  verdictFor,
  type AutoReview,
  type Evidence,
  type PhotoFacts,
  type ReviewDecision,
  type ReviewFacts,
} from "@/lib/domain/auto-review";
import type { SatelliteCheck } from "@/lib/domain/cases";
import type { LocationSource, ReportCategory } from "@/lib/domain/types";
import { haversineKm } from "@/lib/geo";
import { uuidv7 } from "@/lib/server/ids";
import { deleteObject, readObject, replaceObject } from "@/lib/server/storage";
import { screenPhoto, type PhotoScreen } from "./image-safety";
import { satelliteCheck } from "./satellite-check";

/**
 * The report reviewer: picks up citizen reports nobody has decided yet, screens each photo once (safety score,
 * faces blurred in the stored copy), gathers the evidence for it from GhanaWatch's own records, and applies the
 * decision of src/lib/domain/auto-review.ts. Held reports come back when their next check is due. A moderator's
 * decision always wins: the reviewer only writes to a report that is still pending and undecided, in the same
 * statement that checks it.
 */

type Row = typeof communityReports.$inferSelect;
const DAY = 86_400_000;

export interface ReviewDeps {
  screen?: (image: Buffer) => Promise<PhotoScreen>;
  satellite?: typeof satelliteCheck;
}

export type ReviewTally = Record<ReviewDecision | "skipped" | "failed", number>;

export async function reviewDue(now = new Date(), opts: { limit?: number; deps?: ReviewDeps } = {}): Promise<ReviewTally> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(communityReports)
    .where(
      and(
        eq(communityReports.status, "pending"),
        isNull(communityReports.moderatorId),
        or(isNull(communityReports.autoReview), sql`(${communityReports.autoReview}->>'nextCheckAt')::timestamptz <= ${now.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(asc(communityReports.createdAt))
    .limit(opts.limit ?? 25);
  const tally: ReviewTally = { approve: 0, reject: 0, hold: 0, expire: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      tally[await reviewReport(row, now, opts.deps)]++;
    } catch (e) {
      tally.failed++;
      console.error("[reports] review failed", row.id, e instanceof Error ? e.message : e);
      // Try again in a quarter of an hour rather than on every pass.
      const prev = (row.autoReview as unknown as AutoReview | null) ?? null;
      await db
        .update(communityReports)
        .set({ autoReview: { ...(prev ?? { firstReviewedAt: now.toISOString(), checks: 0 }), nextCheckAt: new Date(now.getTime() + 15 * 60_000).toISOString(), error: String(e instanceof Error ? e.message : e).slice(0, 300) } })
        .where(and(eq(communityReports.id, row.id), eq(communityReports.status, "pending")));
    }
  }
  return tally;
}

export async function reviewReport(row: Row, now: Date, deps: ReviewDeps = {}): Promise<ReviewDecision | "skipped"> {
  const db = await getDb();
  const prev = (row.autoReview as unknown as AutoReview | null) ?? null;
  const firstReviewedAt = prev?.firstReviewedAt ?? now.toISOString();

  // 1. The photo screen, once (again only if the safety classifier was unavailable the first time).
  let safety = prev?.safety ?? null;
  let photoKey = row.photoKey;
  if (!safety || safety.nsfw == null) {
    const image = photoKey ? await readObject(photoKey) : null;
    if (image) {
      const s = await (deps.screen ?? screenPhoto)(image);
      safety = { nsfw: s.nsfw == null ? null : Math.round(s.nsfw * 1000) / 1000, faces: Math.max(s.faces.length, safety?.faces ?? 0) };
      if (s.blurred && photoKey) photoKey = await replaceObject(photoKey, s.blurred, "image/webp");
    } else if (!photoKey) {
      safety = { nsfw: 0, faces: 0 };
    }
  }

  // 2. The same photo file in an earlier report.
  let earlierSamePhoto: ReviewFacts["earlierSamePhoto"] = null;
  if (row.photoSha256) {
    const [e] = await db
      .select({ id: communityReports.id, lat: communityReports.lat, lon: communityReports.lon })
      .from(communityReports)
      .where(and(eq(communityReports.photoSha256, row.photoSha256), ne(communityReports.id, row.id), lte(communityReports.createdAt, row.createdAt)))
      .orderBy(asc(communityReports.createdAt))
      .limit(1);
    if (e) earlierSamePhoto = { id: e.id, distanceM: Math.round(haversineKm({ lon: row.lon, lat: row.lat }, { lon: e.lon, lat: e.lat }) * 1000) };
  }

  // 3. What GhanaWatch's sensors and other reporters say about the place and time.
  const evidence = await gatherEvidence(row, now, deps);

  const meta = (row.photoMeta as unknown as PhotoFacts | null) ?? null;
  const facts: ReviewFacts = {
    reportedAt: (row.observedAt ?? row.createdAt).toISOString(),
    lat: row.lat,
    lon: row.lon,
    accuracyM: row.accuracyM,
    locationSource: ((row.locationSource as LocationSource | null) ?? "pin") as LocationSource,
    photo: meta,
    safety,
    earlierSamePhoto,
    evidence,
    firstReviewedAt,
    checks: prev?.checks ?? 0,
  };
  const review = decide(facts, now);

  const set: Partial<typeof communityReports.$inferInsert> = { autoReview: review as unknown as Record<string, unknown> };
  if (photoKey !== row.photoKey) set.photoKey = photoKey;
  if (review.decision === "approve") {
    Object.assign(set, { status: "approved", moderatedAt: now, moderationNote: moderationNote(review, facts), satelliteVerdict: verdictFor(review, true), updatedAt: now });
  } else if (review.decision === "reject") {
    Object.assign(set, { status: "rejected", moderatedAt: now, moderationNote: moderationNote(review, facts), updatedAt: now });
    if (review.reasons.includes("unsafe_photo")) set.photoKey = null;
  } else if (review.decision === "expire") {
    Object.assign(set, { status: "unverified", moderatedAt: now, moderationNote: moderationNote(review, facts), updatedAt: now });
  }
  const updated = await db
    .update(communityReports)
    .set(set)
    .where(and(eq(communityReports.id, row.id), eq(communityReports.status, "pending"), isNull(communityReports.moderatorId)))
    .returning();
  if (!updated.length) return "skipped";

  if (review.decision === "reject" && review.reasons.includes("unsafe_photo") && photoKey) await deleteObject(photoKey).catch(() => undefined);
  if (review.decision === "approve" && updated[0].caseStatus === "reported") {
    await addCaseEvent(row.id, { caseStatus: "confirmed", note: publicNote(review, facts).slice(0, 1000), actorId: null });
  }
  if (review.decision !== "hold") {
    await db.insert(auditLog).values({
      id: uuidv7(),
      actorId: null,
      action: `report_auto_${review.decision}`,
      entity: "community_report",
      entityId: row.id,
      diff: { reasons: review.reasons, evidence: review.evidence.length, version: review.version },
      ipHash: null,
    });
  }
  return review.decision;
}

/** Evidence windows around the time of the report, in days, for kinds of event that come and go. */
const WINDOW_DAYS: Partial<Record<ReportCategory, number>> = { fire: 3, flooding: 10 };

export async function gatherEvidence(row: Row, now: Date, deps: ReviewDeps = {}): Promise<Evidence[]> {
  const db = await getDb();
  const category = row.category as ReportCategory;
  const at = (row.observedAt ?? row.createdAt).getTime();
  const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
  const near = (iso: string, days: number) => Math.abs(Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso) - at) <= days * DAY + DAY / 2;
  const evidence: Evidence[] = [];

  // Satellite detections of a matching kind within 750 m (and radar flood outlines containing the spot).
  let check = (row.satelliteCheck as unknown as SatelliteCheck | null) ?? null;
  if (!check || now.getTime() - Date.parse(check.checkedAt) > 3 * 3_600_000) {
    const fresh = await (deps.satellite ?? satelliteCheck)(row.lon, row.lat, category, now, { closeUp: !check?.closeUp });
    check = { ...fresh, closeUp: fresh.closeUp ?? check?.closeUp ?? null };
    await saveSatelliteCheck(row.id, check);
  }
  const win = WINDOW_DAYS[category];
  for (const d of check.detections) {
    if (win != null && !near(d.imageDate, win)) continue;
    evidence.push({ kind: "satellite", id: d.id, title: d.title, type: d.type, date: d.imageDate, distanceM: d.distanceM });
  }

  // Fires seen from space (VIIRS and MODIS) within 2 km and three days of a fire report.
  if (category === "fire") {
    const d = 0.02;
    const fires = await db
      .select({ lon: firePoints.lon, lat: firePoints.lat, acqDate: firePoints.acqDate, source: firePoints.source })
      .from(firePoints)
      .where(
        and(
          gte(firePoints.lon, row.lon - d),
          lte(firePoints.lon, row.lon + d),
          gte(firePoints.lat, row.lat - d),
          lte(firePoints.lat, row.lat + d),
          gte(firePoints.acqDate, isoDay(at - 3 * DAY)),
          lte(firePoints.acqDate, isoDay(at + 3 * DAY)),
        ),
      )
      .limit(200);
    const best = fires
      .map((f) => ({ ...f, distanceM: Math.round(haversineKm({ lon: row.lon, lat: row.lat }, { lon: f.lon, lat: f.lat }) * 1000) }))
      .filter((f) => f.distanceM <= 2000)
      .sort((a, b) => a.distanceM - b.distanceM)[0];
    if (best) evidence.push({ kind: "fire_hotspot", date: String(best.acqDate), distanceM: best.distanceM, source: best.source });
  }

  // Heavy rain over the district on the day of a flood report or the two days before it.
  if (category === "flooding" && row.districtId) {
    const rain = await db
      .select({ day: districtRain.day, rainMm: districtRain.rainMm, maxHourlyMm: districtRain.maxHourlyMm })
      .from(districtRain)
      .where(and(eq(districtRain.districtId, row.districtId), gte(districtRain.day, isoDay(at - 2 * DAY)), lte(districtRain.day, isoDay(at))))
      .limit(5);
    const heavy = rain.filter((r) => r.rainMm >= 50 || (r.maxHourlyMm ?? 0) >= 20).sort((a, b) => b.rainMm - a.rainMm)[0];
    if (heavy) evidence.push({ kind: "heavy_rain", date: heavy.day, rainMm: heavy.rainMm });
  }

  // The detection the reporter pointed to, if it is within 2 km of the report.
  if (row.changeEventId && !evidence.some((e) => e.kind === "satellite" && e.id === row.changeEventId)) {
    const [ev] = await db
      .select({ id: changeEvents.id, title: changeEvents.titleEn, lon: changeEvents.centroidLon, lat: changeEvents.centroidLat, status: changeEvents.status })
      .from(changeEvents)
      .where(eq(changeEvents.id, row.changeEventId))
      .limit(1);
    if (ev && ev.status !== "dismissed" && ev.lon != null && ev.lat != null) {
      const distanceM = Math.round(haversineKm({ lon: row.lon, lat: row.lat }, { lon: ev.lon, lat: ev.lat }) * 1000);
      if (distanceM <= 2000) evidence.push({ kind: "linked_detection", id: ev.id, title: ev.title, distanceM });
    }
  }

  // Other people's reports of the same kind within 1 km and a week, from another connection and another photo.
  if (row.submittedIpHash) {
    const d = 0.01;
    const others = await db
      .select({ id: communityReports.id, lat: communityReports.lat, lon: communityReports.lon, ip: communityReports.submittedIpHash, sha: communityReports.photoSha256, review: communityReports.autoReview })
      .from(communityReports)
      .where(
        and(
          ne(communityReports.id, row.id),
          eq(communityReports.category, category),
          inArray(communityReports.status, ["pending", "approved"]),
          gte(communityReports.lon, row.lon - d),
          lte(communityReports.lon, row.lon + d),
          gte(communityReports.lat, row.lat - d),
          lte(communityReports.lat, row.lat + d),
          gte(communityReports.createdAt, new Date(at - 7 * DAY)),
          lte(communityReports.createdAt, new Date(Math.min(at + 7 * DAY, now.getTime()))),
        ),
      )
      .limit(50);
    const independent = others
      .filter((o) => o.ip && o.ip !== row.submittedIpHash && o.sha !== row.photoSha256)
      .filter((o) => (o.review as { decision?: string } | null)?.decision !== "reject")
      .map((o) => Math.round(haversineKm({ lon: row.lon, lat: row.lat }, { lon: o.lon, lat: o.lat }) * 1000))
      .filter((m) => m <= 1000);
    if (independent.length) evidence.push({ kind: "other_reports", count: independent.length, nearestM: Math.min(...independent) });
  }

  return evidence;
}
