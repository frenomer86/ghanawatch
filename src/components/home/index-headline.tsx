import { connection } from "next/server";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/domain/types";
import { monthLabel, monthOf } from "@/lib/domain/index";
import { listDistrictNames } from "@/lib/db/repo/boundaries";
import { scorecards } from "@/lib/db/repo/scorecards";
import { latestClosedMonth, nationalSeries, rankings, releaseFor } from "@/lib/server/index/read";
import { fmtHa } from "@/components/scorecards/stat";
import { Button } from "@/components/ui/button";
import { TrendChart } from "@/components/index/trend-chart";
import { LeagueTable } from "@/components/index/league-table";
import { FindDistrict } from "@/components/index/find-district";
import { DistrictMap } from "@/components/maps/district-map";

/**
 * The opening of the home page: the month's finding written as a sentence, beside the map of Ghana's
 * districts shaded by the land newly dug for gold, then the trend and the ranked districts. Before the first
 * month is closed it reports the live scan and says so.
 */
export async function IndexHeadline({ locale }: { locale: Locale }) {
  await connection();
  const [latest, names] = await Promise.all([latestClosedMonth(), listDistrictNames()]);
  if (!latest) return <RunningMonth names={names} locale={locale} />;
  const [series, ranks, release] = await Promise.all([nationalSeries(), rankings(latest.month), releaseFor(latest.month)]);
  const prev = series.at(-2);
  const change = prev && prev.newHa > 0 ? Math.round(((latest.newHa - prev.newHa) / prev.newHa) * 100) : null;
  const values = Object.fromEntries(ranks.map((r) => [r.districtId, r.newHa]));
  const top = latest.topDistrict;
  return (
    <>
      <section aria-labelledby="index-h" className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-14">
        <div className="min-w-0 lg:pt-4">
          <p className="text-[0.9375rem] text-muted-foreground">
            The Galamsey Index for {latest.label}
            {release ? `, published ${new Date(release.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}` : ""}
          </p>
          <h1 id="index-h" className="mt-3 max-w-[18ch] text-[2.375rem] font-bold leading-[1.1] md:text-[3.25rem]">
            {fmtHa(latest.newHa)} hectares of land were newly dug for gold in {latest.label.replace(/ \d{4}$/, "")}.
          </h1>
          <p className="mt-5 max-w-[58ch] text-lg leading-relaxed text-ink-soft">
            {change != null && prev ? `That is ${Math.abs(change)}% ${change >= 0 ? "more" : "less"} than in ${prev.label.replace(/ \d{4}$/, "")}. ` : ""}
            New mining was seen in {latest.districtsAffected} districts
            {top ? `, most of all in ${top.name}` : ""}.
            {latest.ciLow != null && latest.ciHigh != null ? ` Checked against a random sample of sites, the true figure most likely lies between ${fmtHa(latest.ciLow)} and ${fmtHa(latest.ciHigh)} hectares.` : ""}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={`/monthly/${latest.month}`}>Read the {latest.label.replace(/ \d{4}$/, "")} report</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/map">Open the map</Link>
            </Button>
          </div>
          <div className="mt-10 max-w-md">
            <h2 className="font-sans text-base font-semibold">Find your district</h2>
            <p className="mb-3 mt-1 text-[0.9375rem] text-muted-foreground">Everything seen from space where you live, month by month.</p>
            <FindDistrict names={names} locale={locale} />
          </div>
        </div>
        <DistrictMap values={values} unit="hectares" title={`Hectares newly mined in ${latest.label}, by district`} className="min-w-0" />
      </section>

      <section aria-labelledby="trend-h" className="mt-16 border-t pt-8">
        <h2 id="trend-h" className="text-2xl">Month by month</h2>
        <p className="mt-1 max-w-[65ch] text-[0.9375rem] text-muted-foreground">
          Hectares first seen as likely galamsey each month since {series[0]?.label ?? latest.label}, with the range a random check of sites allows.
          Each month is frozen when it closes; corrections are logged, never made silently.
        </p>
        <div className="mt-4">
          <TrendChart data={series.map((s) => ({ month: s.month, value: s.newHa, low: s.ciLow, high: s.ciHigh }))} label="Hectares newly mined per month, with the likely range" highlight={latest.month} />
        </div>
      </section>

      <section aria-labelledby="rank-h" className="mt-16 border-t pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="rank-h" className="text-2xl">The districts with most new mining</h2>
          <Link href="/districts" className="text-[0.9375rem] text-link underline">
            All {names.length} districts
          </Link>
        </div>
        <div className="mt-3">
          <LeagueTable rows={ranks.slice(0, 10)} compact />
        </div>
      </section>
    </>
  );
}

/** Before the first close: what the live scan has found so far, clearly marked as such. */
async function RunningMonth({ names, locale }: { names: string[]; locale: Locale }) {
  const month = monthOf(new Date());
  let cards: Awaited<ReturnType<typeof scorecards>> | null = null;
  try {
    cards = await scorecards();
  } catch {
    cards = null;
  }
  const withMining = cards?.districts.filter((d) => d.miningHa > 0).sort((a, b) => b.miningHa - a.miningHa) ?? [];
  const values = Object.fromEntries(withMining.map((d) => [d.id, d.miningHa]));
  const total = cards?.national.miningHa ?? 0;
  return (
    <>
      <section aria-labelledby="index-h" className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-14">
        <div className="min-w-0 lg:pt-4">
          <p className="text-[0.9375rem] text-muted-foreground">From the live satellite scan, {monthLabel(month)}</p>
          <h1 id="index-h" className="mt-3 max-w-[19ch] text-[2.375rem] font-bold leading-[1.1] md:text-[3.25rem]">
            Satellites have picked out {fmtHa(total)} hectares of likely galamsey across {withMining.length} districts.
          </h1>
          <p className="mt-5 max-w-[58ch] text-lg leading-relaxed text-ink-soft">
            {withMining[0] ? `${withMining[0].name} has the most, ${fmtHa(withMining[0].miningHa)} hectares. ` : ""}
            The first monthly figure is frozen and published when the month closes; until then these numbers grow with every satellite pass.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/map">Open the map</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/districts">District scorecards</Link>
            </Button>
          </div>
          <div className="mt-10 max-w-md">
            <h2 className="font-sans text-base font-semibold">Find your district</h2>
            <p className="mb-3 mt-1 text-[0.9375rem] text-muted-foreground">Everything seen from space where you live.</p>
            <FindDistrict names={names} locale={locale} />
          </div>
        </div>
        <DistrictMap values={values} unit="hectares" title="Hectares of likely mining seen so far, by district" className="min-w-0" />
      </section>

      {withMining.length > 0 && (
        <section aria-labelledby="rank-h" className="mt-16 border-t pt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="rank-h" className="text-2xl">The districts with most mining seen</h2>
            <Link href="/districts" className="text-[0.9375rem] text-link underline">
              All {names.length} districts
            </Link>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full max-w-3xl text-[0.9375rem]">
              <thead>
                <tr className="border-b-2 border-foreground/80 text-left">
                  <th className="py-2 pr-4 font-semibold">District</th>
                  <th className="py-2 pr-4 font-semibold">Region</th>
                  <th className="py-2 pr-4 text-right font-semibold">Likely mining</th>
                  <th className="py-2 text-right font-semibold">Sites</th>
                </tr>
              </thead>
              <tbody>
                {withMining.slice(0, 10).map((d) => (
                  <tr key={d.id} className="border-b">
                    <td className="py-2 pr-4">
                      <Link href={`/districts/${d.slug}`} className="font-medium text-link underline-offset-2 hover:underline">
                        {d.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">{d.region?.replace(/ Region$/, "") ?? ""}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtHa(d.miningHa)} ha</td>
                    <td className="py-2 text-right tabular-nums">{d.miningSites}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
