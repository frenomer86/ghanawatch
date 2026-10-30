import type { NextRequest } from "next/server";
import { landQuery } from "@/lib/domain/validation";
import { env } from "@/lib/server/env";
import { enforceRateLimit, handle, heavyWork, parseQuery } from "@/lib/server/http";
import { landChange, landSummary, makePlot } from "@/lib/server/land/check";
import { landPdf } from "@/lib/server/land/pdf";
import { reportImage } from "@/lib/server/land/report-images";

/**
 * GET /api/v1/land-check/pdf?lat=&lon=&r=
 * The land check as a one-page PDF with dated pictures, every finding's
 * source, and the limits of what satellites can show.
 */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "heavy");
  const q = parseQuery(req, landQuery);
  const plot = makePlot(q.lat, q.lon, q.r);
  const online = `${env().PUBLIC_ORIGIN}/check?lat=${plot.center.lat}&lon=${plot.center.lon}&r=${plot.radiusM}`;
  const pdf = await heavyWork(async () => {
    const summary = await landSummary(plot);
    const [change, before, after, closeUp] = await Promise.all([
      landChange(plot).catch(() => null),
      reportImage(plot, summary, "before").catch(() => null),
      reportImage(plot, summary, "after").catch(() => null),
      reportImage(plot, summary, "closeup").catch(() => null),
    ]);
    return landPdf(summary, change, { before, after, closeUp }, online);
  });
  const name = `ghanawatch-land-check-${plot.center.lat.toFixed(4)}_${plot.center.lon.toFixed(4)}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
});
