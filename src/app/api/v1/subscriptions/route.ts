import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { getDb, rows as toRows } from "@/lib/db/client";
import { alertSubscriptions } from "@/lib/db/schema";
import { subscribeBody } from "@/lib/domain/validation";
import { slugify } from "@/lib/domain/scorecards";
import { env } from "@/lib/server/env";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, HttpError, json, parseJson } from "@/lib/server/http";
import { uuidv7 } from "@/lib/server/ids";
import { allowConfirmationMail, mailConfigured, sendMail } from "@/lib/server/mail";

/**
 * POST /api/v1/subscriptions { email, district?, list? }
 * Subscribes an address to the weekly digest, nationally or for one district. With a mail service set
 * up the address gets a confirmation link first; without one it is confirmed at once. The email is
 * never shown anywhere and leaves only in the digest itself.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "reports");
  const body = await parseJson(req, subscribeBody);
  const db = await getDb();
  let districtId: string | null = null;
  if (body.district) {
    const d = toRows<{ id: string; name: string }>(await db.execute(sql`select id::text, name from admin_boundaries where level = 'district'`)).find((x) => slugify(x.name) === body.district);
    if (!d) throw new HttpError(404, "No such district");
    districtId = d.id;
  }
  const [existing] = toRows<{ id: string; confirmed_at: string | null }>(
    await db.execute(sql`select id::text, confirmed_at::text from alert_subscriptions where lower(email) = ${body.email} and district_id is not distinct from ${districtId}::uuid and unsubscribed_at is null limit 1`),
  );
  // Without a mail service no address can be verified, so none is taken: an unverified list would
  // start receiving mail the day the service is switched on.
  if (!mailConfigured()) throw new HttpError(503, "Email alerts are not available yet; follow the WhatsApp channel or the RSS feed meanwhile");
  const origin = env().PUBLIC_ORIGIN;
  // An address already confirmed gets no second email, but the answer, and the time it takes, is the
  // same either way: the mail goes out after the response, so the endpoint never tells a caller whether
  // an address is on the list. Each confirmation email carries a fresh token (an unconfirmed request
  // asked again gets a new one and its clock restarts; /confirm refuses tokens older than 7 days), and
  // at most a few go to one address a day, so the form cannot be used to flood a stranger's inbox.
  // When the address has had its share of emails for the day nothing changes, so the link it already
  // holds keeps working.
  if (!existing?.confirmed_at && allowConfirmationMail(body.email)) {
    const token = randomBytes(24).toString("base64url");
    if (existing) await db.execute(sql`update alert_subscriptions set token = ${token}, created_at = now(), ip_hash = ${clientIpHash(req)} where id = ${existing.id}::uuid and confirmed_at is null`);
    else await db.insert(alertSubscriptions).values({ id: uuidv7(), email: body.email, districtId, list: body.list, token, confirmedAt: null, ipHash: clientIpHash(req) });
    after(() =>
      sendMail({
        to: body.email,
        subject: "Confirm your GhanaWatch alerts",
        text: `Confirm to receive GhanaWatch's weekly galamsey digest${body.district ? ` for ${body.district}` : ""}:\n${origin}/api/v1/subscriptions/confirm?token=${token}\n\nThe link works for 7 days. If you did not ask for this, ignore this email.`,
      }).catch((e: unknown) => console.error("[subscriptions] confirmation mail failed", e instanceof Error ? e.message : e)),
    );
  }
  return json({ status: "pending", message: "Check your email for a confirmation link." }, { status: 202 });
});
