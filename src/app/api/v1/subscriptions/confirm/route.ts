import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, rows as toRows } from "@/lib/db/client";
import { tokenQuery } from "@/lib/domain/validation";
import { linkPage, postedToken } from "@/lib/server/alerts/link-page";
import { env } from "@/lib/server/env";
import { assertSameOrigin, enforceRateLimit, handle, HttpError, parseQuery } from "@/lib/server/http";

/**
 * GET  /api/v1/subscriptions/confirm?token=… — the page behind the link in the first email; shows a button.
 * POST /api/v1/subscriptions/confirm (token) — confirms the subscription. A link alone never changes
 * anything, so mail scanners that open every link cannot confirm on the reader's behalf. Unconfirmed
 * tokens expire after 7 days.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const { token } = parseQuery(req, tokenQuery);
  return linkPage({
    title: "Confirm your GhanaWatch alerts",
    body: "Press the button to start receiving the weekly digest of likely galamsey sites first seen from space.",
    button: "Yes, send me the weekly digest",
    action: "/api/v1/subscriptions/confirm",
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
  // A confirmation link is good for 7 days from the email that carried it, and never for a subscription
  // already ended; a confirmed one stays confirmed (pressing the button twice is harmless).
  const done = toRows<{ id: string }>(
    await db.execute(sql`
      update alert_subscriptions set confirmed_at = coalesce(confirmed_at, now())
      where token = ${token.data} and unsubscribed_at is null and (confirmed_at is not null or created_at > now() - interval '7 days')
      returning id::text`),
  );
  return NextResponse.redirect(new URL(done.length ? "/alerts?subscribed=1" : "/alerts?expired=1", env().PUBLIC_ORIGIN), 303);
});
