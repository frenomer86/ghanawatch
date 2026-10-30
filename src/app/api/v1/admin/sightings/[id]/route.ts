import type { NextRequest } from "next/server";
import { sightingReviewBody, uuidParam } from "@/lib/domain/validation";
import { reviewSighting } from "@/lib/db/repo/sightings";
import { requireRole } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, handle, HttpError, json, parseJson } from "@/lib/server/http";

/**
 * PATCH /api/v1/admin/sightings/:id { status: confirmed|rejected, expectedUpdatedAt }
 * Moderator decision on a machinery tag, with an optimistic-concurrency check.
 */
export const PATCH = handle(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const { id } = await ctx.params;
  const parsedId = uuidParam.safeParse(id);
  if (!parsedId.success) throw new HttpError(404, "Sighting not found");
  const body = await parseJson(req, sightingReviewBody);
  const updated = await reviewSighting(parsedId.data, body, { id: user.id, ipHash: clientIpHash(req) });
  if (!updated) throw new HttpError(409, "This tag was changed by someone else. Reload and try again.");
  return json({ id: updated.id, status: updated.status, updatedAt: updated.updatedAt });
});
