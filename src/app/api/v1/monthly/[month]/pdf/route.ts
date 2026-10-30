import type { NextRequest } from "next/server";
import { env } from "@/lib/server/env";
import { enforceRateLimit, handle, heavyWork, HttpError } from "@/lib/server/http";
import { TtlCache } from "@/lib/server/explore/cache";
import { MONTH_RE, availableMonths, monthlyReport } from "@/lib/server/scorecards/monthly";
import { monthlyPdf } from "@/lib/server/scorecards/monthly-pdf";

/** One PDF per month, kept as long as the report it is drawn from (10 minutes). */
const pdfs = new TtlCache<Uint8Array<ArrayBuffer>>(24, 10 * 60_000);

/**
 * GET /api/v1/monthly/:month/pdf
 * The monthly "State of Ghana's Environment" report as a PDF (month as YYYY-MM). Drawing a PDF is CPU
 * work, so it counts against the "heavy" limit, runs through the bounded heavy-work queue, and the bytes
 * are reused for everyone asking for the same month.
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "heavy");
  const { month } = await ctx.params;
  if (!MONTH_RE.test(month) || !(await availableMonths()).includes(month)) throw new HttpError(404, "No report for that month");
  const pdf = await pdfs.get(month, () =>
    heavyWork(async () => new Uint8Array(await monthlyPdf(await monthlyReport(month), `${env().PUBLIC_ORIGIN}/monthly/${month}`)) as Uint8Array<ArrayBuffer>),
  );
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="ghanawatch-state-of-environment-${month}.pdf"`,
      "cache-control": "public, max-age=1800",
      "x-content-type-options": "nosniff",
    },
  });
});
