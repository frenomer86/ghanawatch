import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getFormatter, setRequestLocale } from "next-intl/server";
import { CloudRain, MapIcon, Radar, Waves } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RiverWatch } from "@/components/home/river-watch";
import { radarFloods, rainOutlook, rainLevel, RAIN_LEVELS, waterwayEncroachments } from "@/lib/db/repo/floods";
import { listPublicCases } from "@/lib/db/repo/cases";
import type { Locale } from "@/lib/domain/types";

export const metadata: Metadata = { title: "Floods and waterways" };

/**
 * Floods and waterways for all of Ghana: the next three days of rain in every district, river flood
 * forecasts, land seen under water by radar after a forecast or report, flood-prone land on the map, and
 * flood reports from the public.
 */
export default async function FloodsPage({ params }: PageProps<"/[locale]/floods">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">Floods and waterways</h1>
        <p className="mt-2 max-w-[70ch] text-lg text-ink-soft">
          Heavy rain coming in the next three days, rivers forecast to rise, land radar has seen under water, land that has flooded before, and
          flood reports from the public, for every district of Ghana.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/map?flood=1&type=flood_risk&hours=168">
              <MapIcon className="size-4" aria-hidden />
              Flood map
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/report">Report a flood</Link>
          </Button>
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="min-w-0 space-y-12">
            <Suspense fallback={<Skeleton className="h-96 w-full" />}>
              <RainOutlook locale={locale} />
            </Suspense>
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <RadarFloods locale={locale} />
            </Suspense>
            <Suspense fallback={<Skeleton className="h-96 w-full" />}>
              <Encroachments locale={locale} />
            </Suspense>
          </div>
          <div className="space-y-8">
            <Suspense fallback={<Skeleton className="h-72 w-full" />}>
              <RiverWatch locale={locale} />
            </Suspense>
            <section className="rounded-xl border bg-card p-5">
              <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
                <Waves className="size-5 text-sky-700" aria-hidden />
                Land that has flooded before
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Switch on &quot;Flood-prone areas&quot; under Layers on the map to see every place water has covered since 1984: river flood
                plains, wetlands, lagoons and lake shores. Darker blue means flooded more often.
              </p>
              <Link href="/map?flood=1" className="mt-3 inline-block text-sm text-link underline">
                Show flood-prone areas
              </Link>
            </section>
            <Suspense fallback={null}>
              <FloodReports locale={locale} />
            </Suspense>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

const LEVEL_STYLE: Record<ReturnType<typeof rainLevel>, { label: string; cls: string }> = {
  extreme: { label: "Extreme", cls: "bg-sev-urgent-tint text-sev-urgent" },
  veryHeavy: { label: "Very heavy", cls: "bg-sev-elevated-tint text-sev-elevated" },
  heavy: { label: "Heavy", cls: "bg-sev-watch-tint text-sev-watch" },
  light: { label: "", cls: "" },
};

async function RainOutlook({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const all = await rainOutlook();
  if (!all.length) {
    return (
      <section>
        <h2 className="text-2xl font-semibold">Rain in the next three days</h2>
        <p className="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">The rain forecast has not been loaded yet.</p>
      </section>
    );
  }
  const heavy = all.filter((o) => o.maxMm >= RAIN_LEVELS.heavy);
  const shown = (heavy.length ? heavy : all).slice(0, 25);
  const days = all[0].days.map((d) => d.day);
  const day = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <section>
      <h2 className="flex items-center gap-2 text-2xl font-semibold">
        <CloudRain className="size-6 text-sky-700" aria-hidden />
        Rain in the next three days
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {heavy.length
          ? `Heavy rain (${RAIN_LEVELS.heavy} mm or more in a day) is forecast in ${heavy.length} of ${all.length} districts.`
          : `No district has heavy rain (${RAIN_LEVELS.heavy} mm or more in a day) forecast in the next three days. These are the wettest.`}{" "}
        Forecast updated {f.dateTime(new Date(all[0].computedAt), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" })}.
      </p>
      <div className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Rain outlook by district">
        <table className="gw-table w-full min-w-0 text-sm">
          <thead>
            <tr>
              <th>District</th>
              {days.map((d) => (
                <th key={d} className="text-right">
                  {day(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.districtId}>
                <td>
                  <Link href={`/districts/${o.slug}`} className="text-link underline">
                    {o.district}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{o.region?.replace(/ Region$/, "")}</span>
                </td>
                {days.map((d) => {
                  const mm = o.days.find((x) => x.day === d)?.mm ?? 0;
                  const lv = LEVEL_STYLE[rainLevel(mm)];
                  return (
                    <td key={d} className="text-right tabular-nums">
                      {Math.round(mm)} mm
                      {lv.label && <span className={`mt-1 block w-fit rounded-full px-1.5 py-0.5 text-xs font-medium ${lv.cls} ml-auto`}>{lv.label}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Forecast for the centre of each district; storms are local and can fall short of it or exceed it. Heavy: {RAIN_LEVELS.heavy} mm or more in a
        day; very heavy: {RAIN_LEVELS.veryHeavy} mm; extreme: {RAIN_LEVELS.extreme} mm. Weather data by Open-Meteo.com.
      </p>
    </section>
  );
}

const TRIGGER_LABEL: Record<string, string> = { "river-forecast": "after a river flood forecast", "rain-forecast": "after very heavy rain", report: "after a public report" };
const SEV_CLS: Record<string, string> = { urgent: "bg-sev-urgent-tint text-sev-urgent", elevated: "bg-sev-elevated-tint text-sev-elevated", watch: "bg-sev-watch-tint text-sev-watch" };

async function RadarFloods({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const { items, totalHa, districts } = await radarFloods(30, 12);
  const date = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <section>
      <h2 className="flex items-center gap-2 text-2xl font-semibold">
        <Radar className="size-6 text-sky-700" aria-hidden />
        Seen under water by radar
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {items.length
          ? `In the last 30 days Sentinel-1 radar saw about ${totalHa.toLocaleString("en-GB")} ha of land under water in ${districts} ${districts === 1 ? "district" : "districts"}, land that was dry in the same weeks a year earlier.`
          : "No flooding has been seen by radar in the last 30 days."}{" "}
        After every river flood forecast, very heavy rain forecast or approved flood report, each radar pass of the following week is checked; radar
        sees through the cloud that comes with floods. Flooded forest and tall crops can stay bright, so these outlines are the least that flooded.
      </p>
      {items.length > 0 && (
        <div className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Flooding seen by radar">
          <table className="gw-table w-full min-w-0 text-sm">
            <thead>
              <tr>
                <th>Where</th>
                <th>Radar pass</th>
                <th className="text-right">Under water</th>
                <th>Why it was checked</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link href={`/event/${e.id}`} className="text-link underline">
                      {e.district ?? "Ghana"}
                    </Link>
                  </td>
                  <td className="tabular-nums">{date(e.date)}</td>
                  <td className="text-right tabular-nums">
                    {e.areaHa >= 10 ? Math.round(e.areaHa).toLocaleString("en-GB") : e.areaHa.toFixed(1)} ha
                    {SEV_CLS[e.severity] && e.severity !== "watch" && (
                      <span className={`mt-1 ml-auto block w-fit rounded-full px-1.5 py-0.5 text-xs font-medium ${SEV_CLS[e.severity]}`}>{e.severity === "urgent" ? "Large" : "Wide"}</span>
                    )}
                  </td>
                  <td className="text-muted-foreground">{TRIGGER_LABEL[e.trigger ?? ""] ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Contains modified Copernicus Sentinel-1 data, processed by Microsoft Planetary Computer and GhanaWatch.</p>
    </section>
  );
}

async function FloodReports({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const reports = await listPublicCases({ limit: 6, category: "flooding" });
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-heading text-lg font-semibold">Flood reports from the public</h2>
      {reports.length ? (
        <ul className="mt-3 space-y-3 text-sm">
          {reports.map((r) => (
            <li key={r.id}>
              <Link href={`/reports/${r.id}`} className="font-medium text-link underline">
                {r.districtName ?? "Ghana"}
              </Link>
              <span className="text-muted-foreground"> · {f.dateTime(new Date(r.createdAt), { day: "numeric", month: "short" })}</span>
              <p className="line-clamp-2 text-foreground/90">{r.description}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No flood reports have been approved yet. If your area floods, send a photo from the report page.</p>
      )}
    </section>
  );
}

const WATERWAY_LABEL: Record<string, string> = { wetland: "wetland or lagoon", drain: "drain", canal: "canal", river: "river" };

async function Encroachments({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const { items, counts } = await waterwayEncroachments(12);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const date = (iso: string | null) => (iso ? f.dateTime(new Date(`${iso}T12:00:00Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "–");
  return (
    <section>
      <h2 className="text-2xl font-semibold">Clearing and landfill in waterways</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {total
          ? `${total} places where ground was cleared, dug or filled inside a river, drain or wetland in recent months: ${counts.wetland ?? 0} in wetlands and lagoons, ${(counts.drain ?? 0) + (counts.canal ?? 0)} in drains and canals, ${counts.river ?? 0} along rivers.`
          : "No clearing or landfill has been seen inside rivers, drains or wetlands yet."}{" "}
        Each is possible until someone checks it on the ground. From space at 10 m we can see landfill and large structures, not single small
        buildings. Southern Ghana only for now: in the north, river banks change with every season.
      </p>
      {items.length > 0 && (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {items.map((e) => (
            <li key={e.id} className="overflow-hidden rounded-xl border bg-card">
              <Link href={`/event/${e.id}`} className="block">
                <div className="grid grid-cols-2 gap-px bg-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/v1/events/${e.id}/image?role=before`} alt={`Before, ${date(e.beforeDate)}`} loading="lazy" className="aspect-square w-full object-cover" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/v1/events/${e.id}/image?role=latest`} alt={`After, ${date(e.afterDate)}`} loading="lazy" className="aspect-square w-full object-cover" />
                </div>
                <div className="grid grid-cols-2 px-3 pt-1.5 text-[11px] text-muted-foreground">
                  <span>Before {date(e.beforeDate)}</span>
                  <span>After {date(e.afterDate)}</span>
                </div>
                <div className="p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-sky-800">
                    In a {WATERWAY_LABEL[e.waterwayKind] ?? "waterway"}
                    {e.waterwayName ? ` · ${e.waterwayName}` : ""}
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    About {e.areaHa >= 10 ? Math.round(e.areaHa) : e.areaHa.toFixed(1)} ha cleared or filled, {e.district ?? "Ghana"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Possible: not yet checked on the ground</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
