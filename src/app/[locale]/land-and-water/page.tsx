import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { MapIcon } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { monthOf } from "@/lib/domain/index";
import { riverScores } from "@/lib/server/rivers/score";
import { radarFloods, rainOutlook, RAIN_LEVELS } from "@/lib/db/repo/floods";
import { reservoirCards } from "@/lib/db/repo/reservoirs";
import { coastPointsAll } from "@/lib/db/repo/coast";
import { airHeatOutlook, levelCounts } from "@/lib/db/repo/air-heat";
import { coastTotals, strongestStretches } from "@/lib/domain/coast";

export const metadata: Metadata = { title: "Land and water" };

/**
 * One door to everything GhanaWatch watches besides mining itself: rivers, floods, reservoirs and lakes, the
 * coast, and air and heat. Each section gives today's headline and leads to its full page; nothing here is a
 * page of its own in the menu.
 */
export default async function LandAndWaterPage({ params }: PageProps<"/[locale]/land-and-water">) {
  setRequestLocale(resolveLocale((await params).locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">Land and water</h1>
        <p className="mt-2 max-w-[70ch] text-lg text-ink-soft">
          The state of Ghana&apos;s rivers, the floods coming and those radar has seen, the reservoirs that supply water and power, the coast, and
          the air, today. Each section opens its full page; every district&apos;s own page shows the same for that place.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/map">
              <MapIcon className="size-4" aria-hidden />
              Open the map
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/districts">Find your district</Link>
          </Button>
        </div>
        <div className="mt-12 grid gap-x-12 gap-y-14 md:grid-cols-2">
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <Rivers />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <Floods />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <Reservoirs />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <Coast />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <AirHeat />
          </Suspense>
        </div>
      </div>
    </AppShell>
  );
}

function Section({ title, href, cta, children }: { title: string; href: string; cta: string; children: ReactNode }) {
  return (
    <section className="flex flex-col border-t-2 border-foreground/70 pt-4">
      <h2 className="text-2xl">{title}</h2>
      <div className="mt-2 flex-1 text-[0.9375rem] text-ink-soft">{children}</div>
      <Link href={href} className="mt-4 text-[0.9375rem] text-link underline">
        {cta}
      </Link>
    </section>
  );
}

const Figure = ({ value, label }: { value: string; label: string }) => (
  <div>
    <dd className="font-heading text-[1.625rem] font-semibold leading-tight text-foreground tabular-nums">{value}</dd>
    <dt className="text-xs text-muted-foreground">{label}</dt>
  </div>
);
const Unavailable = () => <p className="text-muted-foreground">Not loaded yet.</p>;

/** Each section reads its own data; one source being down leaves the others standing. */
async function safely<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

async function Rivers() {
  await connection();
  const rivers = await safely(() => riverScores(monthOf(new Date())));
  const mapped = rivers?.filter((r) => r.mapped) ?? [];
  const km = mapped.reduce((a, r) => a + r.kmDiscoloured, 0);
  const worst = [...mapped].sort((a, b) => b.kmDiscoloured - a.kmDiscoloured)[0];
  const dredgers = rivers?.reduce((a, r) => a + r.dredgerTargets, 0) ?? 0;
  return (
    <Section title="Rivers" href="/rivers" cta="All rivers, reach by reach">
      {rivers ? (
        <>
          <p>Rivers turned muddy by mining this month, and dredgers seen by radar on the water.</p>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Figure value={`${Math.round(km)} km`} label="of river discoloured" />
            <Figure value={worst && worst.kmDiscoloured > 0 ? worst.river : "–"} label="most affected" />
            <Figure value={String(dredgers)} label="dredger radar targets" />
          </dl>
        </>
      ) : (
        <Unavailable />
      )}
    </Section>
  );
}

async function Floods() {
  await connection();
  const [rain, radar] = await Promise.all([safely(() => rainOutlook()), safely(() => radarFloods(30, 1))]);
  const heavy = rain?.filter((o) => o.maxMm >= RAIN_LEVELS.heavy) ?? [];
  return (
    <Section title="Floods" href="/floods" cta="Rain outlook, river forecasts and flooded land">
      {rain || radar ? (
        <>
          <p>Heavy rain in the next three days, and land radar has seen under water in the last 30 days.</p>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Figure value={rain ? String(heavy.length) : "–"} label={`districts with ${RAIN_LEVELS.heavy} mm or more in a day`} />
            <Figure value={heavy[0] ? `${Math.round(heavy[0].maxMm)} mm` : "–"} label={heavy[0] ? `wettest: ${heavy[0].district}` : "no heavy rain forecast"} />
            <Figure value={radar ? `${radar.totalHa.toLocaleString("en-GB")} ha` : "–"} label={radar ? `under water in ${radar.districts} districts` : "radar"} />
          </dl>
        </>
      ) : (
        <Unavailable />
      )}
    </Section>
  );
}

async function Reservoirs() {
  await connection();
  const cards = (await safely(() => reservoirCards()))?.filter((c) => c.summary.latest) ?? [];
  return (
    <Section title="Reservoirs and lakes" href="/reservoirs" cta="Every reservoir over the last year">
      {cards.length ? (
        <>
          <p>Share of each water body under water at the latest radar passes, and the change over a month.</p>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {cards.slice(0, 8).map((c) => (
              <li key={c.slug} className="flex items-baseline justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <span className="shrink-0 tabular-nums">
                  {Math.round(c.summary.latest!.waterPct)}%
                  <span className={`ml-1 text-xs ${c.summary.trend === "falling" ? "text-sev-elevated" : "text-muted-foreground"}`}>
                    {c.summary.changeMonth == null ? "" : c.summary.trend === "steady" ? "steady" : `${c.summary.changeMonth > 0 ? "+" : ""}${c.summary.changeMonth}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted-foreground">The first radar measurements arrive within a few days of the pipeline starting.</p>
      )}
    </Section>
  );
}

async function Coast() {
  await connection();
  const pts = await safely(() => coastPointsAll());
  const t = pts?.length ? coastTotals(pts) : null;
  const worst = pts?.length ? strongestStretches(pts, -1, 1)[0] : undefined;
  return (
    <Section title="Coast" href="/coast" cta="Where the sea is advancing, kilometre by kilometre">
      {t ? (
        <>
          <p>How Ghana&apos;s shoreline has moved since 2000, measured every kilometre.</p>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Figure value={`${Math.round((t.retreating / t.measured) * 100)}%`} label="of the coast retreating" />
            <Figure value={`${t.severe} km`} label="retreating 2 m a year or faster" />
            <Figure value={worst ? `${Math.abs(worst.rateMYr).toFixed(1)} m/yr` : "–"} label={worst ? `fastest${worst.place ? `, near ${worst.place}` : ""}` : "fastest retreat"} />
          </dl>
        </>
      ) : (
        <Unavailable />
      )}
    </Section>
  );
}

async function AirHeat() {
  await connection();
  const all = await safely(() => airHeatOutlook());
  const c = all?.length ? levelCounts(all) : null;
  return (
    <Section title="Air and heat" href="/air" cta="Every district, today and the next three days">
      {c && all ? (
        <>
          <p>Air quality, Harmattan dust and dangerous heat today, from forecasts for every district.</p>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Figure value={String(c.air.sensitive + c.air.unhealthy + c.air.veryUnhealthy + c.air.hazardous)} label={`of ${all.length} districts with unhealthy air`} />
            <Figure value={String(c.heat.danger + c.heat.extremeDanger)} label="districts with dangerous heat" />
            <Figure value={String(all.filter((o) => (o.days[0]?.dust ?? 0) >= 100).length)} label="districts with Harmattan dust" />
          </dl>
        </>
      ) : (
        <Unavailable />
      )}
    </Section>
  );
}
