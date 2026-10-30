import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { auditLog, users } from "@/lib/db/schema";
import { requireSignedIn } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, HttpError, json, parseJson } from "@/lib/server/http";
import { uuidv7 } from "@/lib/server/ids";
import { openSecret, verifyTotp } from "@/lib/server/totp";

const body = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

/** POST /api/v1/auth/2fa/enable { code } — turns two-step sign-in on once a code from the new key checks out. */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "login");
  const user = await requireSignedIn(req);
  const { code } = await parseJson(req, body, 1024);
  const db = await getDb();
  const [row] = await db.select({ secret: users.totpSecret, enabled: users.totpEnabledAt }).from(users).where(eq(users.id, user.id)).limit(1);
  if (row?.enabled) throw new HttpError(409, "Two-step sign-in is already on");
  if (!row?.secret) throw new HttpError(400, "Start the setup first");
  const step = verifyTotp(openSecret(row.secret), code, null);
  if (step === null) throw new HttpError(400, "That code is not right; check the time on your phone and try the newest code");
  await db.update(users).set({ totpEnabledAt: new Date(), totpLastStep: step, updatedAt: new Date() }).where(eq(users.id, user.id));
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "two_factor_enabled", entity: "user", entityId: user.id, ipHash: clientIpHash(req) });
  return json({ ok: true });
});
