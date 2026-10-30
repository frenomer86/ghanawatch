import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getFormatter, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { PowerReport } from "@/components/power/power-report";
import { PowerMapLoader } from "@/components/power/power-map-loader";
import { districtPower } from "@/lib/db/repo/power";
import type { Locale } from "@/lib/domain/types";

export const metadata: Metadata = { title: "Power cuts" };

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";

/**
 * Power-cut tracker: anonymous "lights off / lights back" reports, a live map, and an open record of hours
 * without power by district, counted only from reports.
 */
export default async function PowerPage({ params }: PageProps<"/[locale]/power">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">Power cuts</h1>
        <p className="mt-2 max-w-[70ch] text-lg text-ink-soft">
          Lights off where you are? Tell everyone in two taps, and see where the power is out across Ghana and how many hours each district has
          gone without it this week. Every number here comes from reports by people like you.
        </p>
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <section aria-labelledby="report-h" className="rounded-xl border bg-card p-5">
            <h2 id="report-h" className="mb-4 text-xl font-semibold">
              Report the power
            </h2>
            <PowerReport styleUrl={STYLE} />
          </section>
          <div className="min-w-0 space-y-8">
            <PowerMapLoader styleUrl={STYLE} />
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <Districts locale={locale} />
            </Suspense>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

async function Districts({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const rows = await districtPower();
  if (!rows.length) {
    return (
      <section>
        <h2 className="text-xl font-semibold">Districts</h2>
        <p className="mt-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No power-cut reports yet. When people report, each district&apos;s status and its hours without power this week appear here.
        </p>
      </section>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.hoursOffWeek));
  return (
    <section>
      <h2 className="text-xl font-semibold">Districts</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Hours off this week are added up from each &quot;lights off&quot; report to the next &quot;lights back&quot; report in the district; an
        outage with no &quot;back&quot; report counts at most 12 hours.
      </p>
      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.district} className="rounded-lg border bg-card p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium">
                {r.district}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{r.region?.replace(/ Region$/, "")}</span>
              </p>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "off" ? "bg-sev-urgent-tint text-sev-urgent" : "bg-sev-normal-tint text-sev-normal"}`}>
                {r.status === "off" ? "Reported off" : "Reported on"} since {f.dateTime(new Date(r.since), { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-2 flex-1 rounded-full bg-muted">
                <div className="h-2 rounded-full bg-sev-urgent-fill" style={{ width: `${(r.hoursOffWeek / max) * 100}%` }} />
              </div>
              <span className="w-32 text-right tabular-nums">{r.hoursOffWeek} h off this week</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {r.reportsToday} report{r.reportsToday === 1 ? "" : "s"} in the last 24 hours from {r.reporters} {r.reporters === 1 ? "person" : "people"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
