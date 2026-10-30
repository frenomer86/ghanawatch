import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { auditLog, corrections } from "@/lib/db/schema";
import { correctionBody } from "@/lib/domain/validation";
import { requireRole } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, handle, json, parseJson } from "@/lib/server/http";
import { uuidv7 } from "@/lib/server/ids";

/** POST /api/v1/admin/corrections — a dated entry in the public corrections log. */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const body = await parseJson(req, correctionBody);
  const db = await getDb();
  const id = uuidv7();
  await db.insert(corrections).values({ id, publishedOn: body.publishedOn, month: body.month ?? null, indexVersion: body.indexVersion, whatChanged: body.whatChanged, why: body.why, createdBy: user.id });
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "correction_added", entity: "correction", entityId: id, diff: body, ipHash: clientIpHash(req) });
  return json({ id }, { status: 201 });
});
