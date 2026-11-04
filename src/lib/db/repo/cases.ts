import { and, asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/lib/db/client";
import { adminBoundaries, auditLog, communityReports, reportCaseEvents } from "@/lib/db/schema";
import type { Authority, CaseStatus, ReportCategory, ReportStatus, SatelliteVerdict } from "@/lib/domain/types";
import { roundPublic, type CaseEvent, type PendingCase, type PublicCase, type SatelliteCheck } from "@/lib/domain/cases";
import { uuidv7 } from "@/lib/server/ids";

/** Citizen reports as public cases: approved reports, their satellite check and their trail. */

const district = alias(adminBoundaries, "district");
const region = alias(adminBoundaries, "region");

type Row = {
  r: typeof communityReports.$inferSelect;
  districtName: string | null;
  regionName: string | null;
};

const baseSelect = () => ({ r: communityReports, districtName: district.name, regionName: region.name });

function toCase(row: Row, timeline: CaseEvent[], exact: boolean): PublicCase {
  const r = row.r;
  return {
    id: r.id,
    category: r.category as ReportCategory,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
    lat: exact ? r.lat : roundPublic(r.lat),
    lon: exact ? r.lon : roundPublic(r.lon),
    districtName: row.districtName,
    regionName: row.regionName,
    status: r.status as ReportStatus,
    caseStatus: r.caseStatus as CaseStatus,
    satelliteVerdict: r.satelliteVerdict as SatelliteVerdict,
    authority: (r.authority as Authority | null) ?? null,
    photoUrl: r.photoKey ? `/api/v1/cases/${r.id}/photo` : null,
    satelliteCheck: (r.satelliteCheck as unknown as SatelliteCheck | null) ?? null,
    checkedBy: r.status !== "approved" ? null : !r.moderatorId && (r.autoReview as { decision?: string } | null)?.decision === "approve" ? "automatic" : "moderator",
    timeline,
  };
}

export async function listPublicCases(opts: { limit: number; category?: ReportCategory }): Promise<PublicCase[]> {
  const db = await getDb();
  const rows = await db
    .select(baseSelect())
    .from(communityReports)
    .leftJoin(district, eq(district.id, communityReports.districtId))
    .leftJoin(region, eq(region.id, district.parentId))
    .where(and(eq(communityReports.status, "approved"), opts.category ? eq(communityReports.category, opts.category) : undefined))
    .orderBy(desc(communityReports.createdAt))
    .limit(opts.limit);
  return rows.map((row) => toCase(row, [], false));
}

export async function caseTimeline(reportId: string): Promise<CaseEvent[]> {
  const db = await getDb();
  const rows = await db.select().from(reportCaseEvents).where(eq(reportCaseEvents.reportId, reportId)).orderBy(asc(reportCaseEvents.createdAt));
  return rows.map((e) => ({ status: e.caseStatus as CaseStatus, authority: (e.authority as Authority | null) ?? null, note: e.note, at: e.createdAt.toISOString() }));
}

/**
 * A case by id. Approved reports are public; anyone with the link to a report
 * still waiting for review sees only that it is waiting. Moderators see it all,
 * with exact coordinates.
 */
export async function getCase(id: string, viewer: { moderator: boolean }): Promise<PublicCase | PendingCase | null> {
  const db = await getDb();
  const [row] = await db
    .select(baseSelect())
    .from(communityReports)
    .leftJoin(district, eq(district.id, communityReports.districtId))
    .leftJoin(region, eq(region.id, district.parentId))
    .where(eq(communityReports.id, id))
    .limit(1);
  if (!row) return null;
  if (row.r.status !== "approved" && !viewer.moderator) {
    return { id: row.r.id, status: row.r.status as PendingCase["status"], createdAt: row.r.createdAt.toISOString() };
  }
  return toCase(row, await caseTimeline(id), viewer.moderator);
}

export async function photoKeyFor(id: string): Promise<{ key: string | null; status: string } | null> {
  const db = await getDb();
  const [row] = await db.select({ key: communityReports.photoKey, status: communityReports.status }).from(communityReports).where(eq(communityReports.id, id)).limit(1);
  return row ?? null;
}

export async function saveSatelliteCheck(id: string, check: SatelliteCheck) {
  const db = await getDb();
  await db
    .update(communityReports)
    .set({ satelliteCheck: check as unknown as Record<string, unknown> })
    .where(eq(communityReports.id, id));
}

export async function addCaseEvent(
  reportId: string,
  ev: { caseStatus: CaseStatus; authority?: Authority | null; note?: string | null; actorId: string | null; ipHash?: string },
) {
  const db = await getDb();
  await db.insert(reportCaseEvents).values({
    id: uuidv7(),
    reportId,
    caseStatus: ev.caseStatus,
    authority: ev.authority ?? null,
    note: ev.note || null,
    actorId: ev.actorId,
  });
  await db
    .update(communityReports)
    .set({ caseStatus: ev.caseStatus, ...(ev.authority ? { authority: ev.authority } : {}), updatedAt: new Date() })
    .where(eq(communityReports.id, reportId));
  if (ev.actorId) {
    await db.insert(auditLog).values({
      id: uuidv7(),
      actorId: ev.actorId,
      action: `case_${ev.caseStatus}`,
      entity: "community_report",
      entityId: reportId,
      diff: { authority: ev.authority ?? null, note: ev.note ?? null },
      ipHash: ev.ipHash ?? null,
    });
  }
}

/** Approved reports moderators are following up, newest first. */
export async function openCases(limit = 50): Promise<PublicCase[]> {
  const db = await getDb();
  const rows = await db
    .select(baseSelect())
    .from(communityReports)
    .leftJoin(district, eq(district.id, communityReports.districtId))
    .leftJoin(region, eq(region.id, district.parentId))
    .where(eq(communityReports.status, "approved"))
    .orderBy(desc(communityReports.updatedAt))
    .limit(limit);
  return rows.filter((r) => r.r.caseStatus !== "closed").map((row) => toCase(row, [], true));
}
