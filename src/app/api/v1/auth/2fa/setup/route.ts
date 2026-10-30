import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { requireSignedIn } from "@/lib/server/auth";
import { assertSameOrigin, enforceRateLimit, handle, HttpError, json } from "@/lib/server/http";
import { newTotpSecret, otpauthUri, sealSecret } from "@/lib/server/totp";

/**
 * POST /api/v1/auth/2fa/setup
 * Starts two-step sign-in for the signed-in account: a new authenticator key,
 * stored encrypted and not active until a code from it is confirmed.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "login");
  const user = await requireSignedIn(req);
  if (user.twoFactor) throw new HttpError(409, "Two-step sign-in is already on");
  const secret = newTotpSecret();
  const db = await getDb();
  await db.update(users).set({ totpSecret: sealSecret(secret), totpLastStep: null }).where(eq(users.id, user.id));
  return json({ secret, uri: otpauthUri(secret, user.email ?? user.displayName) });
});
