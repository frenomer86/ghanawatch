import type { NextRequest } from "next/server";
import { env } from "@/lib/server/env";
import { enforceRateLimit, handle, HttpError } from "@/lib/server/http";
import { MONTH_RE, availableMonths, monthlyReport } from "@/lib/server/scorecards/monthly";
import { monthlyPdf } from "@/lib/server/scorecards/monthly-pdf";

/**
 * GET /api/v1/monthly/:month/pdf
 * The monthly "State of Ghana's Environment" report as a PDF (month as YYYY-MM).
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "public");
  const { month } = await ctx.params;
  if (!MONTH_RE.test(month) || !(await availableMonths()).includes(month)) throw new HttpError(404, "No report for that month");
  const report = await monthlyReport(month);
  const pdf = await monthlyPdf(report, `${env().PUBLIC_ORIGIN}/monthly/${month}`);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="ghanawatch-state-of-environment-${month}.pdf"`,
      "cache-control": "public, max-age=1800",
      "x-content-type-options": "nosniff",
    },
  });
});
