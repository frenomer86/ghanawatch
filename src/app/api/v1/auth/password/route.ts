import { and, eq, ne } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { auditLog, sessions, users } from "@/lib/db/schema";
import { hashPassword, requireSignedIn, SESSION_COOKIE, verifyPassword } from "@/lib/server/auth";
import { createHash } from "node:crypto";
import { env } from "@/lib/server/env";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, HttpError, json, parseJson } from "@/lib/server/http";
import { uuidv7 } from "@/lib/server/ids";

const body = z
  .object({
    current: z.string().min(1).max(256),
    next: z
      .string()
      .min(12, "Use at least 12 characters")
      .max(256)
      .refine((p) => new Set(p).size >= 6, "Use a less repetitive password"),
  })
  .strict()
  .refine((b) => b.current !== b.next, { message: "Choose a different password", path: ["next"] });

/**
 * POST /api/v1/auth/password { current, next }
 * Changes the signed-in user's password. The initial administrator password comes from the server's
 * settings file, so staff must replace it before they can change anything else; every other session of
 * the account is signed out when the password changes.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "login");
  const user = await requireSignedIn(req);
  const b = await parseJson(req, body, 2048);
  const db = await getDb();
  const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id)).limit(1);
  if (!row?.hash || !(await verifyPassword(b.current, row.hash))) throw new HttpError(401, "The current password is not right");
  await db.update(users).set({ passwordHash: await hashPassword(b.next), mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, user.id));
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const thisSession = createHash("sha256").update(`${env().APP_SECRET}:${token}`).digest("hex");
  await db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, thisSession)));
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "password_changed", entity: "user", entityId: user.id, ipHash: clientIpHash(req) });
  return json({ ok: true });
});
