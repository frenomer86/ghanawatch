import fs from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { uuidParam } from "@/lib/domain/validation";
import { photoKeyFor } from "@/lib/db/repo/cases";
import { SESSION_COOKIE, sessionFromToken } from "@/lib/server/auth";
import { env } from "@/lib/server/env";
import { enforceRateLimit, handle, HttpError } from "@/lib/server/http";

/**
 * GET /api/v1/cases/:id/photo
 * The report photo (already stripped of location data and re-encoded when it
 * arrived). Public once the report is approved; moderators can see it before.
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "public");
  const { id } = await ctx.params;
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) throw new HttpError(404, "Photo not found");
  const row = await photoKeyFor(parsed.data);
  if (!row?.key) throw new HttpError(404, "Photo not found");
  if (row.status !== "approved") {
    const user = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
    if ((user?.role !== "moderator" && user?.role !== "admin") || !user.twoFactor) throw new HttpError(404, "Photo not found");
  }
  let body: ArrayBuffer;
  if (/^https:\/\//.test(row.key)) {
    const res = await fetch(row.key, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new HttpError(404, "Photo not found");
    body = await res.arrayBuffer();
  } else {
    const dir = path.join(process.cwd(), env().DATA_DIR, "uploads");
    const file = path.join(dir, row.key);
    const rel = path.relative(dir, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(404, "Photo not found");
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf) throw new HttpError(404, "Photo not found");
    body = new Uint8Array(buf).buffer;
  }
  return new Response(body, {
    headers: {
      "content-type": "image/webp",
      // Moderation can withdraw a photo, so browsers re-check after a day.
      "cache-control": row.status === "approved" ? "public, max-age=86400" : "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
