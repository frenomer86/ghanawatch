import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { moderationBody, uuidParam } from "@/lib/domain/validation";
import { getDb } from "@/lib/db/client";
import { auditLog, communityReports } from "@/lib/db/schema";
import { addCaseEvent } from "@/lib/db/repo/cases";
import { requireRole } from "@/lib/server/auth";
import { uuidv7 } from "@/lib/server/ids";
import { assertSameOrigin, clientIpHash, handle, HttpError, json, parseJson } from "@/lib/server/http";

/**
 * PATCH /api/v1/admin/reports/:id { status, note?, satelliteVerdict?, expectedUpdatedAt }
 * Moderator decision with an optimistic-concurrency check so two moderators
 * cannot both decide the same report. Approving a report makes it a public
 * case and moves its trail from "reported" to "confirmed"; the moderator also
 * records what the satellite evidence shows.
 */
export const PATCH = handle(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const { id } = await ctx.params;
  const parsedId = uuidParam.safeParse(id);
  if (!parsedId.success) throw new HttpError(404, "Report not found");
  const body = await parseJson(req, moderationBody);
  const db = await getDb();
  const updated = await db
    .update(communityReports)
    .set({
      status: body.status,
      moderationNote: body.note ?? null,
      moderatorId: user.id,
      moderatedAt: new Date(),
      updatedAt: new Date(),
      ...(body.satelliteVerdict ? { satelliteVerdict: body.satelliteVerdict } : {}),
    })
    .where(and(eq(communityReports.id, parsedId.data), eq(communityReports.updatedAt, new Date(body.expectedUpdatedAt))))
    .returning();
  if (!updated.length) throw new HttpError(409, "This report was changed by someone else. Reload and try again.");
  const row = updated[0];
  await db.insert(auditLog).values({
    id: uuidv7(),
    actorId: user.id,
    action: `report_${body.status}`,
    entity: "community_report",
    entityId: parsedId.data,
    diff: { note: body.note ?? null, satelliteVerdict: body.satelliteVerdict ?? null },
    ipHash: clientIpHash(req),
  });
  if (body.status === "approved" && row.caseStatus === "reported") {
    await addCaseEvent(parsedId.data, { caseStatus: "confirmed", actorId: user.id, ipHash: clientIpHash(req) });
  }
  return json({ id: parsedId.data, status: body.status, updatedAt: row.updatedAt.toISOString() });
});
