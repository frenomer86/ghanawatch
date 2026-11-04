import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { ChevronRight, Map as MapIcon, ScanEye } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { districtBySlug } from "@/lib/db/repo/scorecards";
import { districtRainOutlook, RAIN_LEVELS } from "@/lib/db/repo/floods";
import { districtAirHeat } from "@/lib/db/repo/air-heat";
import { reservoirsInDistrict } from "@/lib/db/repo/reservoirs";
import { districtCoast } from "@/lib/db/repo/coast";
import { districtPower } from "@/lib/db/repo/power";
import { DistrictMap } from "@/components/maps/district-map";
import { AQI_TEXT, HEAT_TEXT } from "@/lib/domain/air-heat";
import { shareOfArea } from "@/lib/domain/scorecards";
import { districtSeries, latestClosedMonth, releaseFor } from "@/lib/server/index/read";
import { listIntakes, nearestIntake } from "@/lib/server/index/intakes";
import { TrendChart } from "@/components/index/trend-chart";
import { RankArrow } from "@/components/index/rank-arrow";
import { groundViewHref } from "@/lib/explore/imagery";
import { env } from "@/lib/server/env";
import { AppShell } from "@/components/layout/app-shell";
import { BarChart } from "@/components/scorecards/bar-chart";
import { ScorecardNotes } from "@/components/scorecards/notes";
import { EmbedCode, ShareBar } from "@/components/scorecards/share-bar";
import { Stat, fmtHa, firesText } from "@/components/scorecards/stat";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/districts/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  await connection();
  const d = await districtBySlug(slug);
  if (!d) return { title: "District not found" };
  const c = d.card;
  const title = `${c.name} scorecard`;
  const description = c.miningHa
    ? `About ${fmtHa(c.miningHa)} ha of likely galamsey seen from space in ${c.name} (${c.region}), number ${c.rank} of ${d.total} districts.`
    : `What satellites show in ${c.name} (${c.region}): mining, forest reserves, rivers, fires and floods.`;
  // A frozen card once a month has been released; the live card before that.
  const latest = await latestClosedMonth();
  const released = latest ? await releaseFor(latest.month) : null;
  const card = released ? `${env().PUBLIC_ORIGIN}/releases/${latest!.month}/cards/${c.slug}.png` : `${env().PUBLIC_ORIGIN}/api/v1/scorecards/${c.slug}/card`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: card, width: 1200, height: 630, alt: description }] },
    twitter: { card: "summary_large_image", title, description, images: [card] },
  };
}

// Metadata depends on the district's live figures, so this route renders on request.
export const instant = false;

/** One district's scorecard: likely mining and where it is, forest loss and fire history, largest sites, sharing. */
export default async function DistrictPage({ params }: PageProps<"/[locale]/districts/[slug]">) {
  const { locale: raw } = await params;
  setRequestLocale(resolveLocale(raw));
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <Scorecard params={params} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Scorecard({ params }: { params: PageProps<"/[locale]/districts/[slug]">["params"] }) {
  await connection();
  const { slug } = await params;
  const d = await districtBySlug(slug);
  if (!d) notFound();
  const c = d.card;
  const [rain, series, intakes, airHeat, waters, coast, power] = await Promise.all([
    districtRainOutlook(c.id),
    districtSeries(c.id),
    listIntakes(),
    districtAirHeat(c.id),
    reservoirsInDistrict(c.id).catch(() => []),
    districtCoast(c.id).catch(() => null),
    districtPower()
      .then((all) => all.find((p) => p.districtId === c.id) ?? null)
      .catch(() => null),
  ]);
  const airToday = airHeat?.days[0] ?? null;
  const worstAirDay = airHeat?.days.reduce<(typeof airHeat.days)[number] | null>((w, d) => (d.aqi != null && (w?.aqi == null || d.aqi > w.aqi) ? d : w), null) ?? null;
  const latestMonth = series.at(-1) ?? null;
  const released = latestMonth ? await releaseFor(latestMonth.month) : null;
  const origin = env().PUBLIC_ORIGIN;
  const intake = d.bbox ? nearestIntake(intakes, (d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2) : null;
  const siteIntake = d.topSites[0] ? nearestIntake(intakes, d.topSites[0].lon, d.topSites[0].lat) : intake;
  const url = `${origin}/districts/${c.slug}`;
  const share = shareOfArea(c.miningHa, c.areaKm2);
  const lossSince2001 = d.forestLoss.reduce((s, r) => s + r.ha, 0);
  const lastLoss = d.forestLoss.filter((r) => r.ha > 0).at(-1);
  const center = d.bbox ? { lat: (d.bbox[1] + d.bbox[3]) / 2, lon: (d.bbox[0] + d.bbox[2]) / 2 } : null;
  const span = d.bbox ? Math.max(d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1]) : 1;
  const zoom = Math.max(7, Math.min(12, Math.round(Math.log2(360 / span) - 1)));
  const shareText = c.miningHa
    ? `${c.name}: about ${fmtHa(c.miningHa)} ha of likely galamsey seen from space, number ${c.rank} of ${d.total} districts. Live scorecard on GhanaWatch:`
    : `${c.name} on GhanaWatch: mining, forest reserves, rivers, fires and floods seen from space.`;
  return (
    <article>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/districts" className="hover:underline">
          Districts
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        {c.region && (
          <Link href={`/districts?region=${encodeURIComponent(c.region)}`} className="hover:underline">
            {c.region}
          </Link>
        )}
      </nav>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[2.5rem] font-bold leading-tight">{c.name}</h1>
          <p className="mt-1 text-muted-foreground">
            {c.rank ? (
              <>
                Number <strong className="text-foreground">{c.rank}</strong> of {d.total} districts for likely mining seen from space
              </>
            ) : (
              "No likely mining found in the current scan"
            )}
          </p>
          {latestMonth && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                Galamsey Index, {latestMonth.month}: <strong className="text-foreground">{latestMonth.index.toFixed(1)}</strong> ha per 100 km²
                {latestMonth.rank ? ` · ranked ${latestMonth.rank}` : ""}
              </span>
              <RankArrow movement={latestMonth.movement} />
            </p>
          )}
        </div>
        <div className="flex items-start gap-5">
          {center && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/map?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}&z=${zoom}&type=surface_disturbance&hours=2160`}>
                <MapIcon className="size-4" aria-hidden /> Open on map
              </Link>
            </Button>
          )}
          <DistrictMap highlight={c.id} title={`Where ${c.name} lies in Ghana`} legend={false} className="hidden w-28 shrink-0 sm:block" />
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
        <Stat
          tone="mining"
          label="Likely mining"
          value={`${fmtHa(c.miningHa)} ha`}
          sub={
            c.miningSites
              ? `${c.miningSites} sites${share ? `, ${share}% of the district` : ""}${c.newThisMonthHa > 0 && c.newThisMonthHa < c.miningHa ? `; ${fmtHa(c.newThisMonthHa)} ha first seen this month` : ""}`
              : "none found"
          }
        />
        <Stat tone="alert" label="Inside forest reserves" value={`${fmtHa(c.inReservesHa)} ha`} sub={c.reserves.length ? c.reserves.slice(0, 2).join(", ") + (c.reserves.length > 2 ? ` and ${c.reserves.length - 2} more` : "") : "none"} />
        <Stat tone="alert" label="Near homes, schools, clinics" value={String(c.nearPeople)} sub="sites within 300 m or inside residential areas" />
        <Stat label="Rivers turned muddy" value={String(c.muddyRivers)} sub={c.muddyRivers ? `${fmtHa(c.muddyRiversHa)} ha of water` : "none seen"} />
        <Stat label="Seen by radar through cloud" value={`${fmtHa(c.radarHa)} ha`} sub={`${c.radarSites} new ponds`} />
        <Stat label="Fires" value={String(c.fires7d)} sub={firesText(c.fires7d, c.firesUsual7d).replace(/^\d+ /, "")} />
        <Stat
          tone={rain && rain.maxMm >= RAIN_LEVELS.heavy ? "alert" : undefined}
          label="Rain, next 3 days"
          value={rain ? `${Math.round(rain.maxMm)} mm` : "–"}
          sub={`heaviest day${rain && rain.maxMm >= RAIN_LEVELS.heavy ? " (heavy rain)" : ""}${c.floodAlerts ? ` · ${c.floodAlerts} river points above flood level` : ""}`}
        />
        <Stat
          tone={airToday?.aqi != null && airToday.aqi > 100 ? "alert" : undefined}
          label="Air quality today"
          value={airToday?.aqi != null ? `AQI ${airToday.aqi}` : "–"}
          sub={
            airToday?.aqiLevel
              ? `${AQI_TEXT[airToday.aqiLevel].label.toLowerCase()}${airToday.dust != null && airToday.dust >= 100 ? ", Harmattan dust" : ""}${worstAirDay && worstAirDay.day !== airToday.day && (worstAirDay.aqi ?? 0) > (airToday.aqi ?? 0) ? `; up to ${worstAirDay.aqi} in the next days` : ""}`
              : "forecast not loaded yet"
          }
        />
        <Stat
          tone={airToday?.heatLevel === "danger" || airToday?.heatLevel === "extremeDanger" ? "alert" : undefined}
          label="Heat today"
          value={airToday?.feelsLikeMaxC != null ? `${Math.round(airToday.feelsLikeMaxC)} °C` : "–"}
          sub={airToday?.heatLevel ? `feels like at the hottest hour; ${HEAT_TEXT[airToday.heatLevel].label.toLowerCase()}` : "forecast not loaded yet"}
        />
        {waters.map((w) => (
          <Stat
            key={w.slug}
            tone={w.summary.trend === "falling" ? "alert" : undefined}
            label={w.name}
            value={w.summary.latest ? `${Math.round(w.summary.latest.waterPct)}% under water` : "–"}
            sub={
              w.summary.latest
                ? w.summary.changeMonth == null || w.summary.trend === "steady"
                  ? "steady over the last month, from radar"
                  : `${w.summary.trend === "rising" ? "up" : "down"} ${Math.abs(w.summary.changeMonth)} points in a month, from radar`
                : "not measured yet"
            }
          />
        ))}
        {coast && (
          <Stat
            tone={coast.worstRate != null && coast.worstRate <= -2 ? "alert" : undefined}
            label="Coast retreating"
            value={`${coast.retreatingKm} of ${coast.km} km`}
            sub={coast.worstRate != null ? `fastest ${Math.abs(coast.worstRate).toFixed(1)} m a year${coast.worstPlace ? ` near ${coast.worstPlace}` : ""}, since 2000` : "no clear retreat since 2000"}
          />
        )}
        {power && (
          <Stat
            tone={power.status === "off" ? "alert" : undefined}
            label="Power cuts this week"
            value={`${power.hoursOffWeek} h`}
            sub={`${power.status === "off" ? "lights reported off now" : "lights reported on"}; from people's reports`}
          />
        )}
        <Stat label="Reports from the public" value={String(c.reports)} sub={c.reports ? `${c.reportsConfirmed} confirmed by satellite` : "none approved yet"} />
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">
        More on <Link href="/land-and-water" className="text-link underline">land and water</Link> across Ghana. Lights off where you are?{" "}
        <Link href="/power" className="text-link underline">
          Report a power cut
        </Link>
        .
      </p>
      {(c.clearedHa > 0 || c.possibleHa > 0 || c.inMinesHa > 0) && (
        <p className="mt-3 text-sm text-muted-foreground">
          Not counted as likely mining:
          {c.clearedHa > 0 && ` ${fmtHa(c.clearedHa)} ha of bare cleared land without pits (farms and building sites look the same)`}
          {c.clearedHa > 0 && (c.possibleHa > 0 || c.inMinesHa > 0) && ";"}
          {c.possibleHa > 0 && ` ${fmtHa(c.possibleHa)} ha of low-confidence pits or ponds`}
          {c.possibleHa > 0 && c.inMinesHa > 0 && ";"}
          {c.inMinesHa > 0 && ` ${fmtHa(c.inMinesHa)} ha inside named large-scale mines`}.
        </p>
      )}

      {series.length > 0 && (
        <section className="mt-8 rounded-xl border bg-card p-4" aria-labelledby="trend-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="trend-h" className="font-semibold">
              Hectares newly mined each month
            </h2>
            <p className="text-sm text-muted-foreground">{fmtHa(latestMonth?.cumHa ?? 0)} ha since {series[0].month}</p>
          </div>
          <p className="text-sm text-muted-foreground">Land first seen as likely galamsey in {c.name}, month by month, from the frozen index. The thin line is the likely range once false alarms and misses are allowed for.</p>
          <TrendChart data={series.map((m) => ({ month: m.month, value: m.newHa, low: m.ciLow, high: m.ciHigh }))} label={`Hectares newly mined per month in ${c.name}`} highlight={latestMonth?.month} />
        </section>
      )}

      {siteIntake && (
        <p className="mt-4 rounded-lg border-l-4 border-river-600 bg-muted/40 p-3 text-sm">
          Nearest drinking-water intake: <strong>{siteIntake.intake.name}</strong> on the {siteIntake.intake.river}, about {siteIntake.km} km from {d.topSites[0] ? "the largest site here" : "the centre of the district"}.{" "}
          <Link href={`/rivers/${siteIntake.intake.river.toLowerCase()}`} className="text-link underline">
            {siteIntake.intake.river} river scorecard
          </Link>
        </p>
      )}

      {d.topSites.length > 0 && (
        <section className="mt-8" aria-labelledby="pairs-h">
          <h2 id="pairs-h" className="text-xl font-semibold">
            Before and after
          </h2>
          <p className="text-sm text-muted-foreground">The three largest sites, as the satellite saw them a year or more earlier and now. Sentinel-2 true colour, 10 m; the dashed line outlines the change.</p>
          <ul className="mt-3 grid gap-4 sm:grid-cols-3">
            {d.topSites.slice(0, 3).map((s) => (
              <li key={s.id} className="rounded-lg border p-2">
                <div className="grid grid-cols-2 gap-px bg-border">
                  {(["before", "latest"] as const).map((role) => (
                    <div key={role} className="relative aspect-square bg-paper-deep">
                      {/* eslint-disable-next-line @next/next/no-img-element -- rendered by our own image route */}
                      <img src={`/api/v1/events/${s.id}/image?role=${role}`} alt={`${role === "before" ? "Before" : "After"}: ${s.title}`} width={256} height={256} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                      <span className="absolute left-1 top-1 rounded bg-card/90 px-1 py-0.5 text-[10px] font-medium">{role === "before" ? "Before" : "After"}</span>
                    </div>
                  ))}
                </div>
                <Link href={`/event/${s.id}`} className="mt-2 block text-xs font-medium text-link underline-offset-2 hover:underline">
                  {fmtHa(s.areaHa)} ha · evidence page
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.topSites.length > 0 && (
        <section className="mt-8" aria-labelledby="sites-h">
          <h2 id="sites-h" className="text-xl font-semibold">
            Largest likely mining sites
          </h2>
          <ul className="mt-3 divide-y rounded-lg border">
            {d.topSites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <Link href={`/event/${s.id}`} className="font-medium text-link underline-offset-2 hover:underline">
                    {s.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {s.imageDate ? `Seen by satellite ${new Date(s.imageDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                    {s.flags.length ? ` · ${s.flags.join(" · ")}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={s.severity} />
                  <Button asChild variant="ghost" size="sm">
                    <Link href={groundViewHref(s.lat, s.lon, s.id)} aria-label={`Ground view of ${s.title}`}>
                      <ScanEye className="size-4" aria-hidden /> Ground view
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {d.forestLoss.length > 0 && (
          <section className="rounded-xl border bg-card p-4" aria-labelledby="loss-h">
            <h2 id="loss-h" className="font-semibold">
              Tree cover lost each year
            </h2>
            <p className="text-sm text-muted-foreground">
              {fmtHa(lossSince2001)} ha since 2001{lastLoss ? `; ${fmtHa(lastLoss.ha)} ha in ${lastLoss.year}` : ""}. All causes: farms, plantations, fire and mining.
            </p>
            <BarChart data={d.forestLoss.map((r) => ({ x: r.year, y: r.ha }))} label={`Tree cover lost per year in ${c.name}, hectares`} unit="ha" className="fill-forest-500" highlight={lastLoss?.year} />
            <p className="text-xs text-muted-foreground">Hansen/UMD/Google/USGS/NASA, via Global Forest Watch.</p>
          </section>
        )}
        {d.firesByYear.length > 0 && (
          <section className="rounded-xl border bg-card p-4" aria-labelledby="fires-h">
            <h2 id="fires-h" className="font-semibold">
              Fires each year
            </h2>
            <p className="text-sm text-muted-foreground">Vegetation fires seen by satellite, 2020 to 2025.</p>
            <BarChart data={d.firesByYear.filter((r) => r.year <= 2025).map((r) => ({ x: r.year, y: r.fires }))} label={`Fires per year in ${c.name}`} unit="fires" className="fill-sev-elevated-fill" />
            <p className="text-xs text-muted-foreground">NASA FIRMS.</p>
          </section>
        )}
      </div>

      <section className="mt-8 rounded-xl border bg-card p-4" aria-labelledby="share-h">
        <h2 id="share-h" className="font-semibold">
          Share this scorecard
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">The link shows a picture of these numbers when shared, and always opens the latest figures.</p>
        <ShareBar url={url} text={shareText} cardUrl={`/api/v1/scorecards/${c.slug}/card`} cardName={`ghanawatch-${c.slug}.png`} />
        {latestMonth && released && (
          <p className="mt-2 text-xs text-muted-foreground">
            Frozen card for {latestMonth.month}:{" "}
            <a href={`/releases/${latestMonth.month}/cards/${c.slug}.png`} className="text-link underline">
              link preview
            </a>{" "}
            ·{" "}
            <a href={`/releases/${latestMonth.month}/cards/${c.slug}-square.png`} className="text-link underline">
              WhatsApp square
            </a>
          </p>
        )}
        <h3 className="mt-5 text-sm font-semibold">Put it on your website</h3>
        <p className="mb-2 text-sm text-muted-foreground">News sites and assemblies can embed a live card that updates itself.</p>
        <EmbedCode src={`${origin}/embed/district/${c.slug}`} title={`${c.name} on GhanaWatch`} />
      </section>

      <ScorecardNotes fireArchive={c.firesUsual7d !== null} computedAt={new Date().toISOString()} />
    </article>
  );
}
