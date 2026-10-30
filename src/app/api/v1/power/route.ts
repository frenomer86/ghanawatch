import type { NextRequest } from "next/server";
import { and, eq, gte } from "drizzle-orm";
import { powerBody, powerQuery } from "@/lib/domain/validation";
import { getDb } from "@/lib/db/client";
import { powerReports } from "@/lib/db/schema";
import { districtContaining } from "@/lib/db/repo/boundaries";
import { districtPower, powerPoints } from "@/lib/db/repo/power";
import { uuidv7 } from "@/lib/server/ids";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, HttpError, json, parseJson, parseQuery, rateLimit } from "@/lib/server/http";

/**
 * GET /api/v1/power?hours=24: power-cut reports on a 2 km grid, and each district's reported status and
 * hours off this week.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, powerQuery);
  const [points, districts] = await Promise.all([powerPoints(q.hours), districtPower()]);
  return json({ points, districts }, { cache: "short" });
});

/**
 * POST /api/v1/power { kind: "off" | "on", lat, lon, minutesAgo? }: anonymous. The place is rounded to about
 * 300 m. One person can send at most 8 reports an hour, and the same report twice within 30 minutes counts
 * once.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIpHash(req);
  const limit = rateLimit(`power:${ip}`, 8, 3_600_000);
  if (!limit.ok) throw new HttpError(429, "Too many reports; please try again later", { retryAfterSeconds: limit.retryAfterSec });
  const body = await parseJson(req, powerBody, 2 * 1024);
  const db = await getDb();
  const since = new Date(Date.now() - 30 * 60_000);
  const dup = await db
    .select({ id: powerReports.id })
    .from(powerReports)
    .where(and(eq(powerReports.ipHash, ip), eq(powerReports.kind, body.kind), gte(powerReports.createdAt, since)))
    .limit(1);
  if (dup.length) return json({ id: dup[0].id, duplicate: true });
  const lat = Math.round(body.lat * 333) / 333;
  const lon = Math.round(body.lon * 333) / 333;
  const district = await districtContaining(lon, lat).catch(() => null);
  const id = uuidv7();
  await db.insert(powerReports).values({
    id,
    kind: body.kind,
    lat,
    lon,
    districtId: district?.id ?? null,
    happenedAt: new Date(Date.now() - body.minutesAgo * 60_000),
    ipHash: ip,
  });
  return json({ id, district: district?.name ?? null }, { status: 201 });
});
