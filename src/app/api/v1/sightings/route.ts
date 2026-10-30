import type { NextRequest } from "next/server";
import { explorePointQuery, sightingBody } from "@/lib/domain/validation";
import { confirmedSightingsNear, createSighting } from "@/lib/db/repo/sightings";
import { SESSION_COOKIE, sessionFromToken } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, json, parseJson, parseQuery } from "@/lib/server/http";

/**
 * GET /api/v1/sightings?lat=&lon=
 * Confirmed machinery sightings within 3 km of a point, each with the imagery
 * release and capture date it was seen on.
 *
 * POST /api/v1/sightings { lat, lon, kind, count, release, capturedOn?, sensor?, changeEventId?, note? }
 * Tag machinery seen on a dated close-up in Ground view. Anyone may tag
 * (anonymously); a moderator checks public tags before they are shown.
 * Moderators' and administrators' own tags are confirmed at once.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, explorePointQuery);
  const items = await confirmedSightingsNear({ lon: q.lon, lat: q.lat });
  return json({ items }, { cache: "short" });
});

export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "sightings");
  const body = await parseJson(req, sightingBody, 4 * 1024);
  const user = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  const trusted = (user?.role === "moderator" || user?.role === "admin") && !!user?.twoFactor;
  const sighting = await createSighting(body, { userId: user?.id ?? null, trusted, ipHash: clientIpHash(req) });
  return json({ id: sighting.id, status: sighting.status }, { status: 201 });
});
