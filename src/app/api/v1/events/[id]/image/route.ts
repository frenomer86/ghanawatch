import type { NextRequest } from "next/server";
import { uuidParam } from "@/lib/domain/validation";
import { enforceRateLimit, handle, heavyWork, HttpError } from "@/lib/server/http";
import { renderEventImage } from "@/lib/server/events/image";

/**
 * GET /api/v1/events/:id/image?role=latest|before
 *
 * Renders the true-colour Sentinel-2 view of a detection from the public
 * Cloud-Optimized GeoTIFF recorded with the event, cropped to the detection
 * plus a margin, as a 512 px JPEG with the outline drawn on. Radar detections
 * get the Sentinel-1 backscatter instead, in grey (water black). Only files on
 * the Sentinel-2 open-data bucket or the Planetary Computer Sentinel-1 store
 * are ever fetched (no user-supplied URLs). See lib/server/events/image.ts.
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "heavy");
  const { id } = await ctx.params;
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) throw new HttpError(404, "Image not found");
  const role = req.nextUrl.searchParams.get("role") === "before" ? "before" : "latest";
  const jpeg = await heavyWork(() => renderEventImage(parsed.data, role));
  if (!jpeg) throw new HttpError(404, "Image not found");
  return new Response(new Uint8Array(jpeg), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=604800, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});
