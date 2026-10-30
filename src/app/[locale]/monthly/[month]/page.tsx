import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { ChevronRight, FileDown } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { MONTH_RE, availableMonths, monthLabel, monthlyReport } from "@/lib/server/scorecards/monthly";
import { nationalMonth, nationalSeries, rankings, releaseFor } from "@/lib/server/index/read";
import { riverScores } from "@/lib/server/rivers/score";
import { env } from "@/lib/server/env";
import { LeagueTable } from "@/components/index/league-table";
import { TrendChart } from "@/components/index/trend-chart";
import { AppShell } from "@/components/layout/app-shell";
import { ScorecardNotes } from "@/components/scorecards/notes";
import { ShareBar } from "@/components/scorecards/share-bar";
import { Stat, fmtHa } from "@/components/scorecards/stat";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/monthly/[month]">): Promise<Metadata> {
  const { month } = await params;
  if (!MONTH_RE.test(month)) return { title: "Monthly report" };
  return { title: `State of Ghana's Environment, ${monthLabel(month)}`, description: `Galamsey, forest reserves, rivers and fires in Ghana in ${monthLabel(month)}, from GhanaWatch's satellite detections.` };
}

export const instant = false;

/** One month of GhanaWatch: national figures, the districts and reserves most affected, a PDF to download. */
export default async function MonthlyPage({ params }: PageProps<"/[locale]/monthly/[month]">) {
  const { locale } = await params;
  setRequestLocale(resolveLocale(locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <Suspense fallback={<Skeleton className="h-[36rem] w-full" />}>
          <Report params={params} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Report({ params }: { params: PageProps<"/[locale]/monthly/[month]">["params"] }) {
  await connection();
  const { month } = await params;
  if (!MONTH_RE.test(month)) notFound();
  const frozen = await nationalMonth(month);
  if (frozen) return <FrozenReport month={month} />;
  const months = await availableMonths();
  if (!months.includes(month)) notFound();
  const r = await monthlyReport(month);
  const n = r.national;
  const url = `${env().PUBLIC_ORIGIN}/monthly/${month}`;
  return (
    <article>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/districts" className="hover:underline">
          Districts
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span>Monthly report</span>
      </nav>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">State of Ghana&apos;s Environment</h1>
          <p className="mt-1 text-lg text-laterite-700">
            {r.label}
            {r.partial && <span className="text-muted-foreground"> · month in progress</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {months.length > 1 && (
            <nav aria-label="Other months" className="flex flex-wrap gap-1 text-sm">
              {months.map((m) => (
                <Link key={m} href={`/monthly/${m}`} className={m === month ? "rounded-full bg-forest-900 px-3 py-1 text-white" : "rounded-full border px-3 py-1 hover:bg-accent"}>
                  {monthLabel(m)}
                </Link>
              ))}
            </nav>
          )}
          <Button asChild>
            <a href={`/api/v1/monthly/${month}/pdf`}>
              <FileDown className="size-4" aria-hidden /> Download PDF
            </a>
          </Button>
        </div>
      </div>
      {r.firstMonth && (
        <p className="mt-4 rounded-lg border-l-4 border-laterite-600 bg-laterite-100/50 p-3 text-sm">
          This is GhanaWatch&apos;s first month of national scanning, so it includes every change found by comparing the last 120 days with imagery from one to two
          years earlier, not only changes that began in {r.label}. From next month, the report shows only what is new.
        </p>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat tone="mining" label="Likely galamsey first seen" value={`${fmtHa(n.miningHa)} ha`} sub={`${n.miningSites.toLocaleString("en-GB")} sites in ${n.districtsWithMining} districts`} />
        <Stat tone="alert" label="Inside forest reserves" value={`${fmtHa(n.inReservesHa)} ha`} sub={`${n.reservesAffected} reserves`} />
        <Stat tone="alert" label="Near homes, schools, clinics" value={n.nearPeople.toLocaleString("en-GB")} sub="sites within 300 m or inside residential areas" />
        <Stat label="Rivers turned muddy" value={n.muddyRivers.toLocaleString("en-GB")} sub="river stretches" />
        <Stat label="Fires" value={n.fires.toLocaleString("en-GB")} sub={`${n.firesSince ? `since ${new Date(n.firesSince).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}; ` : ""}${n.firesUsual !== null ? `usual for the month ${n.firesUsual.toLocaleString("en-GB")}` : "NASA VIIRS"}`} />
        <Stat label="New ponds seen by radar" value={`${fmtHa(n.radarHa)} ha`} sub="through rainy-season cloud" />
      </dl>

      <section className="mt-8" aria-labelledby="top-h">
        <h2 id="top-h" className="text-xl font-semibold">
          Districts with the most likely galamsey
        </h2>
        {r.topDistricts.length ? (
          <div className="mt-3 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Districts this month">
            <table className="gw-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>District</th>
                  <th>Likely mining</th>
                  <th>Sites</th>
                  <th>In reserves</th>
                  <th>Near people</th>
                  <th>Muddy rivers</th>
                </tr>
              </thead>
              <tbody>
                {r.topDistricts.map((d, i) => (
                  <tr key={d.id}>
                    <td className="tabular-nums">{i + 1}</td>
                    <td>
                      <Link href={`/districts/${d.slug}`} className="font-medium text-link underline-offset-2 hover:underline">
                        {d.name}
                      </Link>
                      <div className="text-xs font-normal text-muted-foreground">{d.region?.replace(/ Region$/, "")}</div>
                    </td>
                    <td className="tabular-nums">{fmtHa(d.miningHa)} ha</td>
                    <td className="tabular-nums">{d.miningSites}</td>
                    <td className="tabular-nums">{d.inReservesHa ? `${fmtHa(d.inReservesHa)} ha` : "–"}</td>
                    <td className="tabular-nums">{d.nearPeople || "–"}</td>
                    <td className="tabular-nums">{d.muddyRivers || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-muted-foreground">No likely galamsey was first seen this month.</p>
        )}
      </section>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {r.topReserves.length > 0 && (
          <section className="rounded-xl border bg-card p-4" aria-labelledby="res-h">
            <h2 id="res-h" className="font-semibold">
              Forest reserves most affected
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {r.topReserves.map((x) => (
                <li key={x.slug}>
                  <Link href={`/reserves/${x.slug}`} className="font-medium text-link underline-offset-2 hover:underline">
                    {x.name}
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}
                    · {fmtHa(x.miningHa)} ha likely mining, {fmtHa(x.clearedHa)} ha cleared
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {r.regions.length > 0 && (
          <section className="rounded-xl border bg-card p-4" aria-labelledby="reg-h">
            <h2 id="reg-h" className="font-semibold">
              By region
            </h2>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {r.regions.map((g) => (
                  <tr key={g.region} className="border-t first:border-t-0">
                    <td className="py-1.5">{g.region.replace(/ Region$/, "")}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtHa(g.miningHa)} ha</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{g.districts} districts</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      <section className="mt-8 rounded-xl border bg-card p-4">
        <h2 className="mb-1 font-semibold">Share the report</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          The monthly report is published here and as a PDF. Emailing it to subscribers and the press needs a mail service account, which is not set up yet.
        </p>
        <ShareBar
          url={url}
          text={`State of Ghana's Environment, ${r.label}: ${fmtHa(n.miningHa)} ha of likely galamsey seen from space, ${fmtHa(n.inReservesHa)} ha inside forest reserves.`}
          cardUrl={r.topDistricts[0] ? `/api/v1/scorecards/${r.topDistricts[0].slug}/card` : "/districts"}
          cardName={`ghanawatch-${month}.png`}
        />
      </section>
      <ScorecardNotes fireArchive computedAt={r.generatedAt} />
    </article>
  );
}

/** A closed month: the frozen index, never the live scan. */
async function FrozenReport({ month }: { month: string }) {
  const [n, series, ranks, release, rivers] = await Promise.all([nationalMonth(month), nationalSeries(), rankings(month), releaseFor(month), riverScores(month)]);
  if (!n) notFound();
  const url = `${env().PUBLIC_ORIGIN}/monthly/${month}`;
  const months = series.map((s) => s.month).reverse();
  const worstRiver = rivers.find((r) => r.mapped && r.kmDiscoloured > 0) ?? null;
  const top = ranks.find((r) => r.rank === 1) ?? null;
  return (
    <article>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/monthly" className="hover:underline">
          Monthly reports
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span>{n.label}</span>
      </nav>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Galamsey from Space</h1>
          <p className="mt-1 text-lg text-laterite-700">
            {n.label} · frozen {new Date(n.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {months.length > 1 && (
            <nav aria-label="Other months" className="flex flex-wrap gap-1 text-sm">
              {months.slice(0, 8).map((m) => (
                <Link key={m} href={`/monthly/${m}`} className={m === month ? "rounded-full bg-forest-900 px-3 py-1 text-white" : "rounded-full border px-3 py-1 hover:bg-accent"}>
                  {monthLabel(m)}
                </Link>
              ))}
            </nav>
          )}
          {release && (
            <Button asChild>
              <a href={`/releases/${month}/ghanawatch_report_${month}.pdf`}>
                <FileDown className="size-4" aria-hidden /> Download PDF
              </a>
            </Button>
          )}
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat tone="mining" label="Newly mined, first seen this month" value={`${fmtHa(n.newHa)} ha`} sub={n.ciLow != null && n.ciHigh != null ? `likely ${fmtHa(n.ciLow)}–${fmtHa(n.ciHigh)} ha · ${n.newSites} sites` : `${n.newSites} sites`} />
        <Stat label={`Since ${series[0]?.label ?? n.label}`} value={`${fmtHa(n.cumHa)} ha`} sub="cumulative, same method" />
        <Stat tone="alert" label="Inside forest reserves" value={`${fmtHa(n.inReservesHa)} ha`} sub="of this month's new mining" />
        <Stat label="Districts with new mining" value={String(n.districtsAffected)} sub={top ? `first: ${top.name}` : ""} />
      </dl>

      <section className="mt-8 rounded-xl border bg-card p-4">
        <h2 className="font-semibold">Hectares first seen as likely galamsey, each month</h2>
        <TrendChart data={series.map((s) => ({ month: s.month, value: s.newHa, low: s.ciLow, high: s.ciHigh }))} label="Hectares newly mined per month" highlight={month} />
      </section>

      <section className="mt-8" aria-labelledby="league-h">
        <h2 id="league-h" className="text-xl font-semibold">
          The league table
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">Every district with new mining this month, ranked by the index: new hectares per 100 km².</p>
        <LeagueTable rows={ranks} />
      </section>

      <section className="mt-8 grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-semibold">Rivers</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {rivers.map((r) => (
                <tr key={r.slug} className="border-t first:border-t-0">
                  <td className="py-1.5">
                    <Link href={`/rivers/${r.slug}`} className="text-link underline-offset-2 hover:underline">
                      {r.river}
                    </Link>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{r.mapped ? `${r.kmDiscoloured} km discoloured` : "not mapped"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {worstRiver && <p className="mt-2 text-xs text-muted-foreground">Worst this month: the {worstRiver.river}.</p>}
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-semibold">Files of this release</h2>
          {release ? (
            <ul className="mt-2 space-y-1 text-sm">
              <li>
                <a href={`/releases/${month}/ghanawatch_report_${month}.pdf`} className="text-link underline">
                  Eight-page PDF report
                </a>
              </li>
              <li>
                <a href={`/releases/${month}/press-release.md`} className="text-link underline">
                  Press release
                </a>{" "}
                (<a href={`/releases/${month}/press-release.docx`} className="text-link underline">Word</a>)
              </li>
              <li>
                <a href={`/releases/${month}/ghanawatch_index_${month}.csv`} className="text-link underline">
                  Index per district (CSV)
                </a>
              </li>
              <li>
                <a href={`/releases/${month}/ghanawatch_districts_${month}.geojson`} className="text-link underline">
                  District outlines with figures (GeoJSON)
                </a>
              </li>
              <li>
                <a href={`/releases/${month}/ghanawatch_sites_${month}.geojson`} className="text-link underline">
                  Sites first seen this month (GeoJSON)
                </a>
              </li>
              <li>
                <a href={`/releases/${month}/ghanawatch_rivers_${month}.csv`} className="text-link underline">
                  Rivers (CSV)
                </a>{" "}
                ·{" "}
                <a href={`/releases/${month}/ghanawatch_reserves_${month}.csv`} className="text-link underline">
                  Reserves (CSV)
                </a>
              </li>
              <li>
                <a href={`/releases/${month}/manifest.json`} className="text-link underline">
                  Manifest with file hashes
                </a>
                {release.doi && (
                  <>
                    {" "}
                    · <a href={`https://doi.org/${release.doi}`} className="text-link underline">DOI {release.doi}</a>
                  </>
                )}
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">This month is closed but its release files have not been published yet.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">CC BY 4.0. Contains modified Copernicus Sentinel data.</p>
        </div>
      </section>

      <section className="mt-8 rounded-xl border bg-card p-4">
        <h2 className="mb-1 font-semibold">Share the report</h2>
        <ShareBar url={url} text={`Galamsey from Space, ${n.label}: ${fmtHa(n.newHa)} ha newly mined for gold first seen from space${top ? `; ${top.name} ranks first` : ""}.`} cardUrl={release && top ? `/releases/${month}/cards/${top.slug}-square.png` : top ? `/api/v1/scorecards/${top.slug}/card` : "/districts"} cardName={`ghanawatch-${month}.png`} />
      </section>
      <ScorecardNotes fireArchive computedAt={n.closedAt} />
    </article>
  );
}
