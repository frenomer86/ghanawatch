import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { accuracyChecks, auditLog } from "@/lib/db/schema";
import { accuracyCheckBody } from "@/lib/domain/validation";
import { requireRole } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, handle, json, parseJson } from "@/lib/server/http";
import { uuidv7 } from "@/lib/server/ids";
import { clearIndexCache } from "@/lib/server/index/read";

/**
 * POST /api/v1/admin/accuracy-checks
 * A moderator records a random-sample check from the review sheet. It appears on the accuracy page at
 * once; a headline optical check also sets the precision the next index close uses.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const body = await parseJson(req, accuracyCheckBody);
  const db = await getDb();
  const id = uuidv7();
  await db.insert(accuracyChecks).values({ id, checkedOn: body.checkedOn, label: body.label, kind: body.kind, region: body.region ?? null, checked: body.checked, correct: body.correct, note: body.note ?? null, headline: body.headline, createdBy: user.id });
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "accuracy_check_added", entity: "accuracy_check", entityId: id, diff: body, ipHash: clientIpHash(req) });
  clearIndexCache();
  return json({ id }, { status: 201 });
});
