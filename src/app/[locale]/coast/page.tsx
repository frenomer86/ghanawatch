import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { Waves } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { coastPointsAll, type CoastPointRow } from "@/lib/db/repo/coast";
import { coastLevel, coastTotals, strongestStretches } from "@/lib/domain/coast";

export const metadata: Metadata = { title: "Coastline" };

/**
 * Ghana's coastline from 2000: where the sea is taking the land, how fast, and where the shore is growing,
 * kilometre by kilometre, from Digital Earth Africa's annual shorelines.
 */
export default async function CoastPage({ params }: PageProps<"/[locale]/coast">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">Coastline</h1>
        <p className="mt-2 max-w-[72ch] text-lg text-ink-soft">
          Where the sea is taking Ghana&apos;s land and where the shore is growing, kilometre by kilometre since 2000, measured from every year of
          Landsat images with the tide taken out.
        </p>
        <Suspense fallback={<Skeleton className="mt-8 h-[36rem] w-full" />}>
          <Body />
        </Suspense>
      </div>
    </AppShell>
  );
}

const LEVEL: Record<ReturnType<typeof coastLevel>, { label: string; cls: string }> = {
  severe: { label: "Severe", cls: "bg-sev-urgent-tint text-sev-urgent" },
  high: { label: "High", cls: "bg-sev-elevated-tint text-sev-elevated" },
  moderate: { label: "Moderate", cls: "bg-sev-watch-tint text-sev-watch" },
  low: { label: "Little change", cls: "bg-muted text-muted-foreground" },
  growing: { label: "Growing", cls: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200" },
};

const where = (p: CoastPointRow) => [p.place ? `near ${p.place}` : null, p.district].filter(Boolean).join(", ") || `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
const mapHref = (p: CoastPointRow) => `/map?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&z=14`;

async function Body() {
  await connection();
  const pts = await coastPointsAll();
  if (!pts.length) return <p className="mt-8 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">The coastline data has not been loaded yet.</p>;
  const t = coastTotals(pts);
  const eroding = strongestStretches(pts, -1, 15);
  const growing = strongestStretches(pts, 1, 6);
  const year = Math.max(...pts.map((p) => p.latestYear ?? 0));
  const pct = (n: number) => `${Math.round((n / t.measured) * 100)}%`;
  return (
    <>
      <dl className="mt-8 grid gap-3 sm:grid-cols-3">
        <Card label="Shoreline retreating" value={pct(t.retreating)} sub={`${t.retreating} of ${t.measured} kilometres, a clear trend since 2000`} alert />
        <Card label="Retreating 2 m a year or faster" value={`${t.severe} km`} sub="where homes, roads and farms are lost within a generation" alert={t.severe > 0} />
        <Card label="Shoreline growing" value={pct(t.growing)} sub="sand building up or land reclaimed, beside sea defences, harbours and river mouths" />
      </dl>

      <section className="mt-10" aria-labelledby="erode-h">
        <h2 id="erode-h" className="flex items-center gap-2 text-2xl font-semibold">
          <Waves className="size-6 text-sky-700" aria-hidden />
          Where the sea is advancing fastest
        </h2>
        <p className="mt-2 max-w-[75ch] text-sm text-muted-foreground">
          The fastest-retreating stretches, at least 4 km apart, with how far the shoreline has moved inland from 2000 to {year}.
        </p>
        <Table rows={eroding} label="Fastest-retreating stretches of coast" />
      </section>

      {growing.length > 0 && (
        <section className="mt-10" aria-labelledby="grow-h">
          <h2 id="grow-h" className="text-xl font-semibold">
            Where the shore is growing
          </h2>
          <Table rows={growing} label="Fastest-growing stretches of coast" />
        </section>
      )}

      <p className="mt-10 max-w-[80ch] text-xs text-muted-foreground">
        Each row summarises the shoreline within about 1 km. A trend counts when it is statistically significant (p &lt; 0.01), the data are
        rated good and the rate is at least half a metre a year. Lagoon shores are included. Data: Digital Earth Africa Coastlines (CC BY 4.0),
        annual shorelines from Landsat, corrected for the tide; towns from OpenStreetMap.
      </p>
    </>
  );
}

function Table({ rows, label }: { rows: CoastPointRow[]; label: string }) {
  return (
    <div className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label={label}>
      <table className="gw-table w-full min-w-0 text-sm">
        <thead>
          <tr>
            <th>Where</th>
            <th className="text-right">Rate</th>
            <th className="text-right">Moved since 2000</th>
            <th>Level</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const lv = LEVEL[coastLevel(p.rateMYr)];
            return (
              <tr key={`${p.lon},${p.lat}`}>
                <td>
                  <Link href={mapHref(p)} className="text-link underline">
                    {where(p)}
                  </Link>
                </td>
                <td className="text-right tabular-nums">{`${p.rateMYr > 0 ? "+" : ""}${p.rateMYr.toFixed(1)} m a year`}</td>
                <td className="text-right tabular-nums">{p.changeM == null ? "–" : `${Math.abs(Math.round(p.changeM))} m ${p.changeM < 0 ? "inland" : "seaward"}`}</td>
                <td>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${lv.cls}`}>{lv.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Card({ label, value, sub, alert }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${alert ? "border-sev-elevated/40 bg-sev-elevated-tint" : "bg-card"}`}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{sub}</dd>
    </div>
  );
}
