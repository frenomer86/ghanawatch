import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { auditLog, confirmationSamples } from "@/lib/db/schema";
import { sampleVerdictBody, uuidParam } from "@/lib/domain/validation";
import { requireRole } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, handle, HttpError, json, parseJson } from "@/lib/server/http";
import { uuidv7 } from "@/lib/server/ids";

/**
 * PATCH /api/v1/admin/samples/:id { verdict: confirmed|rejected|unclear, note? }
 * The moderator's verdict on one site of the month's confirmation sample, after looking at it in Ground
 * view. Rejected sites leave the index when the month is released.
 */
export const PATCH = handle(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const { id } = await ctx.params;
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) throw new HttpError(404, "Sample not found");
  const body = await parseJson(req, sampleVerdictBody);
  const db = await getDb();
  const [row] = await db.update(confirmationSamples).set({ verdict: body.verdict, note: body.note ?? null, reviewedBy: user.id, reviewedAt: new Date() }).where(eq(confirmationSamples.id, parsed.data)).returning();
  if (!row) throw new HttpError(404, "Sample not found");
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "sample_verdict", entity: "confirmation_sample", entityId: row.id, diff: body, ipHash: clientIpHash(req) });
  return json({ id: row.id, verdict: body.verdict });
});
