import type { NextRequest } from "next/server";
import { passQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, HttpError, parseQuery } from "@/lib/server/http";
import { renderPass } from "@/lib/server/explore/passes";

/**
 * GET /api/v1/explore/pass?scene=&lat=&lon=
 *
 * One Sentinel-2 pass over a point: a 4 km square cut from the scene's
 * true-colour Cloud-Optimized GeoTIFF on the AWS open-data bucket, as JPEG.
 * The scene id is validated and the file URL is built from it, so no
 * user-supplied URL is ever fetched. X-GW-Cloud and X-GW-Nodata give the share
 * of the square under bright cloud and outside the satellite's swath, so the
 * viewer can skip unusable passes.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, passQuery);
  let frame;
  try {
    frame = await renderPass(q.scene, q.lon, q.lat);
  } catch (e) {
    console.error("[explore/pass]", q.scene, e instanceof Error ? e.message : e);
    throw new HttpError(502, "This satellite pass could not be read");
  }
  return new Response(new Uint8Array(frame.jpeg), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=2592000, immutable",
      "x-content-type-options": "nosniff",
      "x-gw-cloud": frame.cloud.toFixed(3),
      "x-gw-nodata": frame.nodata.toFixed(3),
    },
  });
});
