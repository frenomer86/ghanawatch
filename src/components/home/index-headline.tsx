import { connection } from "next/server";
import { ArrowRight, FileText } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/domain/types";
import { monthLabel, monthOf } from "@/lib/domain/index";
import { listDistrictNames } from "@/lib/db/repo/boundaries";
import { latestClosedMonth, nationalSeries, rankings, releaseFor } from "@/lib/server/index/read";
import { monthlyReport } from "@/lib/server/scorecards/monthly";
import { riverScores } from "@/lib/server/rivers/score";
import { fmtHa } from "@/components/scorecards/stat";
import { TrendChart } from "@/components/index/trend-chart";
import { LeagueTable } from "@/components/index/league-table";
import { FindDistrict } from "@/components/index/find-district";

/**
 * The headline of the home page: the latest closed month of the Galamsey Index, the trend, the ten
 * districts ranked highest, "find your district" and the latest report. Before the first month is
 * closed it shows the running month from the live scan and says so.
 */
export async function IndexHeadline({ locale }: { locale: Locale }) {
  await connection();
  const [latest, names] = await Promise.all([latestClosedMonth(), listDistrictNames()]);
  const twi = locale === "tw";
  if (!latest) return <RunningMonth names={names} locale={locale} twi={twi} />;
  const [series, ranks, release, rivers] = await Promise.all([nationalSeries(), rankings(latest.month), releaseFor(latest.month), riverScores(latest.month)]);
  const worstRiver = rivers.find((r) => r.mapped && r.kmDiscoloured > 0) ?? null;
  const first = series[0];
  return (
    <section aria-labelledby="index-h" className="rounded-2xl border bg-card p-5 md:p-7">
      <p className="text-sm font-medium uppercase tracking-wide text-laterite-700">{twi ? "Galamsey Index" : "The Galamsey Index"} · {latest.label}</p>
      <h2 id="index-h" className="mt-2 font-heading text-5xl font-semibold leading-none tabular-nums md:text-6xl">
        {fmtHa(latest.newHa)} ha
      </h2>
      <p className="mt-2 max-w-[60ch] text-lg">
        {twi ? "asase a wɔtutu sika foforɔ wɔ so a satellite hunuu no" : "of land newly mined for gold, first seen from space in"} {latest.label}
        {latest.ciLow != null && latest.ciHigh != null && (
          <span className="text-muted-foreground">
            {" "}
            ({twi ? "ɛbɛyɛ" : "likely"} {fmtHa(latest.ciLow)}–{fmtHa(latest.ciHigh)} ha)
          </span>
        )}
        .
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-muted/60 p-3">
          <dt className="text-xs text-muted-foreground">Since {first ? first.label : latest.label}</dt>
          <dd className="font-heading text-2xl font-semibold tabular-nums">{fmtHa(latest.cumHa)} ha</dd>
        </div>
        <div className="rounded-lg bg-muted/60 p-3">
          <dt className="text-xs text-muted-foreground">Districts with new mining</dt>
          <dd className="font-heading text-2xl font-semibold tabular-nums">{latest.districtsAffected}</dd>
        </div>
        <div className="rounded-lg bg-laterite-100 p-3 text-laterite-700">
          <dt className="text-xs">Ranked first</dt>
          <dd className="font-heading text-xl font-semibold leading-tight">
            {latest.topDistrict ? (
              <Link href={`/districts/${latest.topDistrict.slug}`} className="underline-offset-2 hover:underline">
                {latest.topDistrict.name}
              </Link>
            ) : (
              "–"
            )}
          </dd>
        </div>
        <div className="rounded-lg bg-muted/60 p-3">
          <dt className="text-xs text-muted-foreground">{worstRiver ? `${worstRiver.river} turned brown` : "Rivers turned brown"}</dt>
          <dd className="font-heading text-2xl font-semibold tabular-nums">{worstRiver ? `${worstRiver.kmDiscoloured} km` : "0 km"}</dd>
        </div>
      </dl>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-muted-foreground">Hectares first seen as likely galamsey, each month</h3>
        <TrendChart data={series.map((s) => ({ month: s.month, value: s.newHa, low: s.ciLow, high: s.ciHigh }))} label="Hectares newly mined per month, with the likely range" highlight={latest.month} />
      </div>

      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-lg font-semibold">The ten districts ranked highest</h3>
          <Link href="/districts" className="inline-flex items-center gap-1 text-sm text-link underline">
            All {names.length} districts <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
        <div className="mt-2">
          <LeagueTable rows={ranks.slice(0, 10)} compact />
        </div>
      </div>

      <div className="mt-6 rounded-xl bg-forest-50 p-4 dark:bg-secondary">
        <h3 className="text-base font-semibold">Find your district</h3>
        <p className="mb-3 text-sm text-muted-foreground">What has been seen from space where you live, since the record began.</p>
        <FindDistrict names={names} locale={locale} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
        <Link href={`/monthly/${latest.month}`} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
          <FileText className="size-4" aria-hidden /> {latest.label} report{release ? " and PDF" : ""}
        </Link>
        <Link href="/alerts" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
          Weekly alerts
        </Link>
        <Link href="/data/methods" className="text-muted-foreground underline-offset-2 hover:underline">
          How the index is made
        </Link>
      </div>
    </section>
  );
}

/** Before the first close: the running month from the live scan, clearly marked as such. */
async function RunningMonth({ names, locale, twi }: { names: string[]; locale: Locale; twi: boolean }) {
  const month = monthOf(new Date());
  let r: Awaited<ReturnType<typeof monthlyReport>> | null = null;
  try {
    r = await monthlyReport(month);
  } catch {
    r = null;
  }
  return (
    <section aria-labelledby="index-h" className="rounded-2xl border bg-card p-5 md:p-7">
      <p className="text-sm font-medium uppercase tracking-wide text-laterite-700">{twi ? "Galamsey Index" : "The Galamsey Index"} · {monthLabel(month)}, month in progress</p>
      <h2 id="index-h" className="mt-2 font-heading text-5xl font-semibold leading-none tabular-nums md:text-6xl">
        {r ? `${fmtHa(r.national.miningHa)} ha` : "–"}
      </h2>
      <p className="mt-2 max-w-[60ch] text-lg">
        of land seen as likely galamsey so far this month, from the live scan. The first frozen monthly figure is published when the month closes.
      </p>
      <div className="mt-6 rounded-xl bg-forest-50 p-4 dark:bg-secondary">
        <h3 className="text-base font-semibold">Find your district</h3>
        <FindDistrict names={names} locale={locale} />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
        <Link href="/districts" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
          District scorecards
        </Link>
        <Link href="/data/methods" className="text-muted-foreground underline-offset-2 hover:underline">
          How the index is made
        </Link>
      </div>
    </section>
  );
}
