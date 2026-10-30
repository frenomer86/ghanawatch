import type { NextRequest } from "next/server";
import { uuidParam } from "@/lib/domain/validation";
import { getCase } from "@/lib/db/repo/cases";
import { SESSION_COOKIE, sessionFromToken } from "@/lib/server/auth";
import { enforceRateLimit, handle, HttpError, json } from "@/lib/server/http";

/**
 * GET /api/v1/cases/:id
 * One case with its full trail. Before approval, anyone with the link sees
 * only that it is waiting for review; moderators see everything.
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "public");
  const { id } = await ctx.params;
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) throw new HttpError(404, "Case not found");
  const user = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  const moderator = (user?.role === "moderator" || user?.role === "admin") && user.twoFactor;
  const found = await getCase(parsed.data, { moderator });
  if (!found) throw new HttpError(404, "Case not found");
  return json(found, { cache: "none" });
});
