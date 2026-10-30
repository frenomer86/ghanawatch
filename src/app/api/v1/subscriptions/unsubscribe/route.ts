import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { tokenQuery } from "@/lib/domain/validation";
import { linkPage, postedToken } from "@/lib/server/alerts/link-page";
import { env } from "@/lib/server/env";
import { assertSameOrigin, enforceRateLimit, handle, HttpError, parseQuery } from "@/lib/server/http";

/**
 * GET  /api/v1/subscriptions/unsubscribe?token=… — the page behind the link at the foot of every digest.
 * POST /api/v1/subscriptions/unsubscribe (token) — ends the subscription. Following the link alone does
 * nothing, so a mail scanner cannot unsubscribe a reader by prefetching it.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const { token } = parseQuery(req, tokenQuery);
  return linkPage({
    title: "Unsubscribe from GhanaWatch alerts",
    body: "Press the button to stop the weekly digest. You can subscribe again at any time.",
    button: "Unsubscribe",
    action: "/api/v1/subscriptions/unsubscribe",
    token,
    origin: env().PUBLIC_ORIGIN,
  });
});

export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "public");
  const token = tokenQuery.shape.token.safeParse(await postedToken(req));
  if (!token.success) throw new HttpError(400, "Invalid token");
  const db = await getDb();
  await db.execute(sql`update alert_subscriptions set unsubscribed_at = now() where token = ${token.data} and unsubscribed_at is null`);
  return NextResponse.redirect(new URL("/alerts?unsubscribed=1", env().PUBLIC_ORIGIN), 303);
});
