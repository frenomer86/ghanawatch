import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getLocale, setRequestLocale } from "next-intl/server";
import { CalendarDays, Trees } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { getPathname, Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/domain/types";
import { scorecards } from "@/lib/db/repo/scorecards";
import { shareOfArea, type DistrictCard } from "@/lib/domain/scorecards";
import { AppShell } from "@/components/layout/app-shell";
import { Stat, fmtHa } from "@/components/scorecards/stat";
import { ScorecardNotes as Notes } from "@/components/scorecards/notes";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "District scorecards",
  description: "Every district of Ghana ranked by likely galamsey seen from space, with forest reserves, rivers turned muddy, fires and flood forecasts.",
};

const SORTS = {
  mining: { label: "Likely mining", by: (c: DistrictCard) => c.miningHa },
  share: { label: "Share of land", by: (c: DistrictCard) => shareOfArea(c.miningHa, c.areaKm2) ?? 0 },
  reserves: { label: "In reserves", by: (c: DistrictCard) => c.inReservesHa },
  people: { label: "Near people", by: (c: DistrictCard) => c.nearPeople },
  rivers: { label: "Muddy rivers", by: (c: DistrictCard) => c.muddyRivers },
  fires: { label: "Fires this week", by: (c: DistrictCard) => c.fires7d },
} as const;
type SortKey = keyof typeof SORTS;

/** All districts ranked by likely mining, with filters by region and other measures. */
export default async function DistrictsPage({ params, searchParams }: PageProps<"/[locale]/districts">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold">District scorecards</h1>
            <p className="mt-2 text-muted-foreground">
              What satellites show in each of Ghana&apos;s districts: land that looks newly mined for gold, forest reserves and homes it reaches, rivers turned
              muddy, fires and flood forecasts. Ranked by likely mining, from GhanaWatch&apos;s live detections.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link href="/reserves" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
              <Trees className="size-4" aria-hidden /> Forest reserves
            </Link>
            <Link href="/monthly" className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 hover:bg-accent">
              <CalendarDays className="size-4" aria-hidden /> Monthly report
            </Link>
          </div>
        </div>
        <Suspense fallback={<Skeleton className="mt-8 h-[32rem] w-full" />}>
          <Ranking searchParams={searchParams} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Ranking({ searchParams }: { searchParams: PageProps<"/[locale]/districts">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const locale = (await getLocale()) as Locale;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const s = await scorecards();
  const regions = [...new Set(s.districts.map((d) => d.region).filter((r): r is string => !!r))].sort();
  const region = regions.includes(one(sp.region) ?? "") ? one(sp.region)! : null;
  const sort: SortKey = (Object.keys(SORTS) as SortKey[]).includes(one(sp.sort) as SortKey) ? (one(sp.sort) as SortKey) : "mining";
  const rows = s.districts.filter((d) => !region || d.region === region).sort((a, b) => SORTS[sort].by(b) - SORTS[sort].by(a) || (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const n = s.national;
  const href = (o: { region?: string | null; sort?: SortKey }) => {
    const q = new URLSearchParams();
    const r = o.region === undefined ? region : o.region;
    const so = o.sort ?? sort;
    if (r) q.set("region", r);
    if (so !== "mining") q.set("sort", so);
    const qs = q.toString();
    return qs ? `/districts?${qs}` : "/districts";
  };
  return (
    <>
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat tone="mining" label="Likely mining, Ghana" value={`${fmtHa(n.miningHa)} ha`} sub={`${n.miningSites.toLocaleString("en-GB")} sites in ${n.districtsWithMining} districts`} />
        <Stat label="Of which seen by radar" value={`${fmtHa(n.radarHa)} ha`} sub="through rainy-season cloud" />
        <Stat tone="alert" label="Inside forest reserves" value={`${fmtHa(n.inReservesHa)} ha`} sub={`${n.reservesAffected} reserves`} />
        <Stat tone="alert" label="Near homes, schools, clinics" value={n.nearPeople.toLocaleString("en-GB")} sub="sites within 300 m or inside residential areas" />
        <Stat label="Rivers turned muddy" value={n.muddyRivers.toLocaleString("en-GB")} sub="stretches in mining areas" />
        <Stat label="Fires" value={n.fires7d.toLocaleString("en-GB")} sub={n.firesUsual7d === null ? "in the last 7 days" : `last 7 days; usually ${Math.round(n.firesUsual7d)}`} />
      </dl>

      <nav aria-label="Filter by region" className="mt-6 flex flex-wrap gap-1.5 text-sm">
        <Link href={href({ region: null })} className={cn("rounded-full border px-3 py-1", !region ? "bg-forest-900 text-white" : "hover:bg-accent")}>
          All regions
        </Link>
        {regions.map((r) => (
          <Link key={r} href={href({ region: r })} className={cn("rounded-full border px-3 py-1", region === r ? "bg-forest-900 text-white" : "hover:bg-accent")}>
            {r.replace(/ Region$/, "")}
          </Link>
        ))}
      </nav>

      <div className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="District ranking">
        <table className="gw-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>District</th>
              {(Object.keys(SORTS) as SortKey[]).map((k) => (
                <th key={k} aria-sort={sort === k ? "descending" : undefined}>
                  <Link href={href({ sort: k })} className={cn("underline-offset-2 hover:underline", sort === k && "text-forest-900 underline")}>
                    {SORTS[k].label}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const share = shareOfArea(d.miningHa, d.areaKm2);
              return (
                <tr key={d.id}>
                  <td className="tabular-nums">{d.rank ?? "–"}</td>
                  <td>
                    {/* A plain link: 260 client <Link>s would each hydrate and prefetch their scorecard. */}
                    <a href={getPathname({ href: `/districts/${d.slug}`, locale })} className="font-medium text-link underline-offset-2 hover:underline">
                      {d.name}
                    </a>
                    <div className="text-xs font-normal text-muted-foreground">{d.region?.replace(/ Region$/, "")}</div>
                  </td>
                  <td className="tabular-nums">
                    {d.miningHa > 0 ? `${fmtHa(d.miningHa)} ha` : "–"}
                    {d.miningSites > 0 && <div className="text-xs text-muted-foreground">{d.miningSites} sites</div>}
                  </td>
                  <td className="tabular-nums">{share ? `${share}%` : "–"}</td>
                  <td className="tabular-nums">{d.inReservesHa > 0 ? `${fmtHa(d.inReservesHa)} ha` : "–"}</td>
                  <td className="tabular-nums">{d.nearPeople || "–"}</td>
                  <td className="tabular-nums">{d.muddyRivers || "–"}</td>
                  <td className="tabular-nums">
                    {d.fires7d}
                    {d.firesUsual7d !== null && <div className="text-xs text-muted-foreground">usually {d.firesUsual7d < 10 ? d.firesUsual7d.toFixed(1) : Math.round(d.firesUsual7d)}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Notes fireArchive={s.fireArchive} computedAt={s.computedAt} />
    </>
  );
}
