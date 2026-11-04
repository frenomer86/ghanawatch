import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getFormatter, setRequestLocale } from "next-intl/server";
import { Droplets, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { reservoirCards, type ReservoirCard } from "@/lib/db/repo/reservoirs";
import { smoothed } from "@/lib/domain/reservoirs";
import type { Locale } from "@/lib/domain/types";

export const metadata: Metadata = { title: "Reservoirs and lakes" };

/**
 * How much of Ghana's main reservoirs and lakes is under water, from every Sentinel-1 radar pass: the water
 * that runs the Akosombo, Kpong and Bui dams, supplies Accra, Kumasi and Bolgatanga, and irrigates the north.
 */
export default async function ReservoirsPage({ params }: PageProps<"/[locale]/reservoirs">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">Reservoirs and lakes</h1>
        <p className="mt-2 max-w-[72ch] text-lg text-ink-soft">
          How much of each of Ghana&apos;s main reservoirs and lakes is under water, measured by radar every few days through cloud and haze: the water
          behind the Akosombo, Kpong and Bui dams, the reservoirs that supply Accra, Kumasi and Bolgatanga, and the irrigation lakes of the north.
        </p>
        <Suspense fallback={<Skeleton className="mt-8 h-[40rem] w-full" />}>
          <Cards locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Cards({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const cards = await reservoirCards();
  const day = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  if (!cards.some((c) => c.summary.latest)) {
    return <p className="mt-8 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">The first radar measurements have not been made yet. They arrive within a few days of the pipeline starting.</p>;
  }
  return (
    <>
      <ul className="mt-8 grid gap-4 md:grid-cols-2">
        {cards.map((c) => (
          <li key={c.slug} className="rounded-xl border bg-card p-5">
            <Card c={c} day={day} />
          </li>
        ))}
      </ul>
      <p className="mt-8 max-w-[80ch] text-xs text-muted-foreground">
        Each figure is the share of a water body&apos;s largest mapped extent (Digital Earth Africa Waterbodies, from Landsat since 1984) that radar
        sees as open water, so 100% means as full as it has been seen. It measures the area of the water surface, not its depth or volume: a
        steep-sided lake can lose metres of depth with little change in area. Floating weed such as water hyacinth and wind-roughened water can read
        as land on a single pass, so the figures use a running median of three passes. Contains modified Copernicus Sentinel data; water body
        outlines from Digital Earth Africa Waterbodies (CC BY 4.0).
      </p>
    </>
  );
}

function Card({ c, day }: { c: ReservoirCard; day: (iso: string) => string }) {
  const s = c.summary;
  const Trend = s.trend === "rising" ? TrendingUp : s.trend === "falling" ? TrendingDown : Minus;
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Droplets className="size-5 text-sky-700" aria-hidden />
            {c.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            {c.region}
            {c.areaKm2 ? ` · largest extent ${c.areaKm2 >= 100 ? Math.round(c.areaKm2).toLocaleString("en-GB") : c.areaKm2.toFixed(1)} km²` : ""}
          </p>
        </div>
        {s.latest && (
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">{Math.round(s.latest.waterPct)}%</p>
            <p className="text-xs text-muted-foreground">under water, {day(s.latest.date)}</p>
          </div>
        )}
      </div>
      <p className="mt-2 text-sm">{c.use}</p>
      {s.latest ? (
        <>
          <Sparkline c={c} />
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1">
              <Trend className={`size-4 ${s.trend === "falling" ? "text-sev-elevated" : s.trend === "rising" ? "text-sky-700" : "text-muted-foreground"}`} aria-hidden />
              {s.changeMonth == null
                ? "No comparison yet"
                : s.trend === "steady"
                  ? "Steady over the last month"
                  : `${s.trend === "rising" ? "Up" : "Down"} ${Math.abs(s.changeMonth)} points in a month`}
            </span>
            {s.changeYear != null && (
              <span className="text-muted-foreground">
                {Math.abs(s.changeYear) < 2 ? "about the same as a year ago" : `${Math.abs(s.changeYear)} points ${s.changeYear > 0 ? "more" : "less"} than a year ago`}
              </span>
            )}
            <span className="text-muted-foreground">{s.latest.waterKm2 >= 100 ? Math.round(s.latest.waterKm2).toLocaleString("en-GB") : s.latest.waterKm2.toFixed(1)} km² of water</span>
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Not measured yet.</p>
      )}
    </>
  );
}

/** The last year: each pass as a dot, the running median as a line; 0–100% of the largest extent. */
function Sparkline({ c }: { c: ReservoirCard }) {
  const pts = c.series;
  if (pts.length < 2) return null;
  const sm = smoothed(pts);
  const W = 320;
  const H = 64;
  const t0 = Date.parse(`${pts[0].date}T00:00:00Z`);
  const t1 = Date.parse(`${pts.at(-1)!.date}T00:00:00Z`);
  const lo = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.waterPct)) / 10) * 10 - 10);
  const x = (d: string) => ((Date.parse(`${d}T00:00:00Z`) - t0) / Math.max(1, t1 - t0)) * (W - 8) + 4;
  const y = (v: number) => H - 4 - ((v - lo) / Math.max(1, 100 - lo)) * (H - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 h-16 w-full" role="img" aria-label={`${c.name}: share under water over the last year, from ${lo}% to 100%`}>
      <line x1={4} x2={W - 4} y1={y(100)} y2={y(100)} className="stroke-border" strokeDasharray="3 3" />
      {pts.map((p) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.waterPct)} r={1.6} className="fill-sky-700/30" />
      ))}
      <polyline points={sm.map((p) => `${x(p.date).toFixed(1)},${y(p.waterPct).toFixed(1)}`).join(" ")} className="fill-none stroke-sky-700" strokeWidth={1.8} strokeLinejoin="round" />
      <text x={W - 4} y={y(100) - 2} textAnchor="end" className="fill-muted-foreground text-[9px]">
        100%
      </text>
      <text x={W - 4} y={H - 1} textAnchor="end" className="fill-muted-foreground text-[9px]">
        {lo}%
      </text>
    </svg>
  );
}
