import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { ChevronRight } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { monthLabel, monthOf } from "@/lib/domain/index";
import { riverBySlug } from "@/lib/server/rivers/score";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/scorecards/stat";
import { ReachStrip } from "@/components/index/reach-strip";
import { TrendChart } from "@/components/index/trend-chart";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/rivers/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  await connection();
  const r = await riverBySlug(slug);
  if (!r) return { title: "River not found" };
  return {
    title: `${r.river} river scorecard`,
    description: `${r.kmDiscoloured} km of the ${r.river} turned brown this month, seen from space; reach by reach, with drinking-water intakes.`,
  };
}

export const instant = false;

export default async function RiverPage({
  params,
}: PageProps<"/[locale]/rivers/[slug]">) {
  const { locale } = await params;
  setRequestLocale(resolveLocale(locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <Suspense fallback={<Skeleton className="h-[30rem] w-full" />}>
          <River params={params} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function River({
  params,
}: {
  params: PageProps<"/[locale]/rivers/[slug]">["params"];
}) {
  await connection();
  const { slug } = await params;
  const month = monthOf(new Date());
  const r = await riverBySlug(slug, month);
  if (!r) notFound();
  return (
    <article>
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-sm text-muted-foreground"
      >
        <Link href="/rivers" className="hover:underline">
          Rivers
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span>{r.river}</span>
      </nav>
      <h1 className="mt-2 text-3xl font-semibold">The {r.river}</h1>
      <p className="mt-1 text-muted-foreground">
        {monthLabel(month)}, month in progress.
      </p>
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          tone="alert"
          label="Discoloured this month"
          value={`${r.kmDiscoloured} km`}
          sub={
            r.mapped
              ? `of ${r.lengthKm} km mapped`
              : "river line not mapped yet"
          }
        />
        <Stat
          tone="alert"
          label="Heavily discoloured"
          value={`${r.kmHeavy} km`}
          sub="brown water of 5 ha or more"
        />
        <Stat
          label="Muddy-water sites"
          value={String(r.muddySites)}
          sub="Sentinel-2 detections within 1 km"
        />
        <Stat
          label="Dredger radar targets"
          value={String(r.dredgerTargets)}
          sub="last 120 days, Sentinel-1"
        />
      </dl>
      {r.mapped && (
        <section className="mt-8" aria-labelledby="reaches-h">
          <h2 id="reaches-h" className="text-xl font-semibold">
            Reach by reach
          </h2>
          <p className="text-sm text-muted-foreground">
            From the first mapped section to the last, about 10 km each. Intakes
            are marked on the reach they draw from.
          </p>
          <ReachStrip reaches={r.reaches} tall />
          <div
            className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
            tabIndex={0}
            role="region"
            aria-label="Reaches of the river"
          >
            <table className="gw-table">
              <thead>
                <tr>
                  <th>Reach</th>
                  <th>km</th>
                  <th>This month</th>
                  <th>Muddy sites</th>
                  <th>Dredger targets</th>
                  <th>Intakes</th>
                </tr>
              </thead>
              <tbody>
                {r.reaches.map((x) => (
                  <tr key={x.n}>
                    <td className="tabular-nums">{x.n}</td>
                    <td className="tabular-nums">
                      {x.startKm}–{x.endKm}
                    </td>
                    <td>
                      {x.class === "heavy"
                        ? "Heavily discoloured"
                        : x.class === "discoloured"
                          ? "Discoloured"
                          : "Clear"}
                    </td>
                    <td className="tabular-nums">{x.muddySites || "–"}</td>
                    <td className="tabular-nums">{x.dredgerTargets || "–"}</td>
                    <td>{x.intakes.map((i) => i.name).join("; ") || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {r.series.length > 0 && (
        <section
          className="mt-8 rounded-xl border bg-card p-4"
          aria-labelledby="series-h"
        >
          <h2 id="series-h" className="font-semibold">
            Kilometres discoloured, month by month
          </h2>
          <TrendChart
            data={r.series.map((s) => ({
              month: s.month,
              value: s.kmDiscoloured,
            }))}
            label={`Kilometres of the ${r.river} discoloured per month`}
            highlight={month}
            unit="km"
          />
        </section>
      )}
      <p className="mt-6 text-sm text-muted-foreground">
        A reach counts as discoloured when a Sentinel-2 turbid-water detection
        lies within 1 km of it in the month; heavy rain can also turn a river
        brown, so a single month is a sign, not a verdict. Intake coordinates
        are approximate plant locations from public records.
      </p>
    </article>
  );
}
