import type { NextRequest } from "next/server";
import { landImageQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, heavyWork, HttpError, parseQuery } from "@/lib/server/http";
import { landSummary, makePlot } from "@/lib/server/land/check";
import { reportImage } from "@/lib/server/land/report-images";

/** GET /api/v1/land-check/image?lat=&lon=&r=&layer=before|after|closeup — one dated picture of the plot, outlined. */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "heavy");
  const q = parseQuery(req, landImageQuery);
  const plot = makePlot(q.lat, q.lon, q.r);
  const img = await heavyWork(async () => reportImage(plot, await landSummary(plot), q.layer));
  if (!img) throw new HttpError(404, "No picture of this kind for the plot");
  return new Response(new Uint8Array(img.jpeg), {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
});
