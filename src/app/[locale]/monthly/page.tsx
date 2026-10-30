import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { ChevronRight, FileDown, FileText, Newspaper } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { monthLabel } from "@/lib/domain/index";
import { nationalSeries, releasesList } from "@/lib/server/index/read";
import { availableMonths } from "@/lib/server/scorecards/monthly";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtHa } from "@/components/scorecards/stat";

export const metadata: Metadata = {
  title: "Monthly reports",
  description: "Galamsey from Space: the monthly Galamsey Index releases, each with a PDF report, a press release and open data.",
};

/** The reports hub: every released month with its PDF, press release and data; then months closed but not yet released; then the running month. */
export default async function MonthlyIndex({ params }: PageProps<"/[locale]/monthly">) {
  setRequestLocale(resolveLocale((await params).locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/districts" className="hover:underline">
            Districts
          </Link>
          <ChevronRight className="size-3.5" aria-hidden />
          <span>Monthly reports</span>
        </nav>
        <h1 className="mt-2 text-3xl font-semibold">Galamsey from Space</h1>
        <p className="mt-2 text-muted-foreground">
          The Galamsey Index is released on the first Monday of every month for the month before: a frozen number for every district, a ranking, the
          rivers and reserves, and the evidence. Each release has an eight-page PDF, a press release and open data under CC BY 4.0.
        </p>
        <Suspense fallback={<Skeleton className="mt-6 h-40 w-full" />}>
          <Months />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Months() {
  await connection();
  const [releases, series, live] = await Promise.all([releasesList(), nationalSeries(), availableMonths()]);
  const released = new Map(releases.map((r) => [r.month, r]));
  const closed = series.map((s) => s.month).reverse();
  const running = live.filter((m) => !closed.includes(m));
  if (!closed.length && !running.length) return <p className="mt-6 rounded-lg border border-dashed p-8 text-center text-muted-foreground">No detections yet, so no report.</p>;
  return (
    <ul className="mt-6 divide-y rounded-lg border">
      {closed.map((m) => {
        const rel = released.get(m);
        const nat = series.find((s) => s.month === m)!;
        return (
          <li key={m} className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <FileText className="size-5 text-laterite-600" aria-hidden />
              <Link href={`/monthly/${m}`} className="font-medium text-link underline-offset-2 hover:underline">
                {monthLabel(m)}
              </Link>
              <span className="text-sm text-muted-foreground">
                {fmtHa(nat.newHa)} ha newly mined · {nat.districtsAffected} districts{nat.topDistrict ? ` · first: ${nat.topDistrict.name}` : ""}
              </span>
              {rel ? <span className="rounded-full bg-forest-50 px-2 py-0.5 text-xs text-forest-900">Released</span> : <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Closed, not yet released</span>}
            </div>
            {rel && (
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                <a href={`/releases/${m}/ghanawatch_report_${m}.pdf`} className="inline-flex items-center gap-1 text-link underline">
                  <FileDown className="size-4" aria-hidden /> PDF report
                </a>
                <a href={`/releases/${m}/press-release.md`} className="inline-flex items-center gap-1 text-link underline">
                  <Newspaper className="size-4" aria-hidden /> Press release
                </a>
                <a href={`/releases/${m}/press-release.docx`} className="text-link underline">
                  Word
                </a>
                <a href={`/releases/${m}/ghanawatch_index_${m}.csv`} className="text-link underline">
                  Index CSV
                </a>
                <a href={`/releases/${m}/ghanawatch_sites_${m}.geojson`} className="text-link underline">
                  Sites GeoJSON
                </a>
                <a href={`/releases/${m}/manifest.json`} className="text-link underline">
                  Manifest
                </a>
                {rel.doi && (
                  <a href={`https://doi.org/${rel.doi}`} className="text-link underline">
                    DOI {rel.doi}
                  </a>
                )}
              </div>
            )}
          </li>
        );
      })}
      {running.map((m) => (
        <li key={m}>
          <Link href={`/monthly/${m}`} className="flex items-center gap-3 p-4 hover:bg-accent">
            <FileText className="size-5 text-muted-foreground" aria-hidden />
            <span className="font-medium">{monthLabel(m)}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Month in progress, live figures</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
