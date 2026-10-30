import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { reviewBody, uuidParam } from "@/lib/domain/validation";
import { getDb } from "@/lib/db/client";
import { auditLog, changeEvents } from "@/lib/db/schema";
import { requireRole } from "@/lib/server/auth";
import { uuidv7 } from "@/lib/server/ids";
import { assertSameOrigin, clientIpHash, handle, HttpError, json, parseJson } from "@/lib/server/http";

/** PATCH /api/v1/admin/events/:id { status: reviewed|dismissed|verified, expectedUpdatedAt } — detection review (FR-17). */
export const PATCH = handle(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const { id } = await ctx.params;
  const parsedId = uuidParam.safeParse(id);
  if (!parsedId.success) throw new HttpError(404, "Event not found");
  const body = await parseJson(req, reviewBody);
  const db = await getDb();
  const updated = await db
    .update(changeEvents)
    .set({ status: body.status, reviewedBy: user.id, reviewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(changeEvents.id, parsedId.data), eq(changeEvents.updatedAt, new Date(body.expectedUpdatedAt))))
    .returning();
  if (!updated.length) throw new HttpError(409, "This detection was changed by someone else. Reload and try again.");
  await db.insert(auditLog).values({
    id: uuidv7(),
    actorId: user.id,
    action: `event_${body.status}`,
    entity: "change_event",
    entityId: parsedId.data,
    ipHash: clientIpHash(req),
  });
  return json({ id: parsedId.data, status: body.status, updatedAt: (updated[0] as { updatedAt: Date }).updatedAt.toISOString() });
});
