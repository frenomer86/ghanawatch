import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getFormatter, setRequestLocale } from "next-intl/server";

import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { airHeatOutlook, levelCounts, type DistrictAirHeat } from "@/lib/db/repo/air-heat";
import { AQI_LEVELS, AQI_TEXT, DUST_HAZE, HEAT_LEVELS, HEAT_TEXT } from "@/lib/domain/air-heat";
import type { Locale } from "@/lib/domain/types";
import { AQI_CLS, HEAT_CLS } from "@/components/air/levels";

export const metadata: Metadata = { title: "Air and heat" };

/**
 * Air quality and heat stress for every district of Ghana: today and the next days, the worst districts first,
 * with what each level means and what to do. Harmattan dust drives the air from November to March; heat is
 * worst in the north before the rains.
 */
export default async function AirPage({ params }: PageProps<"/[locale]/air">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">Air and heat</h1>
        <p className="mt-2 max-w-[70ch] text-lg text-ink-soft">
          How clean the air is and how dangerous the heat will be, today and in the next days, for every district of Ghana. Harmattan dust, smoke from
          burning and traffic fumes all count; so does the humidity that makes heat harder on the body.
        </p>
        <Suspense fallback={<Skeleton className="mt-8 h-[40rem] w-full" />}>
          <Body locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Body({ locale }: { locale: Locale }) {
  await connection();
  const f = await getFormatter({ locale });
  const all = await airHeatOutlook();
  if (!all.length) {
    return <p className="mt-8 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">The air and heat forecast has not been loaded yet.</p>;
  }
  const { air, heat, today } = levelCounts(all);
  const days = [...new Set(all.flatMap((o) => o.days.map((d) => d.day)))].sort().slice(0, 4);
  const day = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const todayOf = (o: DistrictAirHeat) => o.days.find((d) => d.day === today);
  const unhealthy = air.sensitive + air.unhealthy + air.veryUnhealthy + air.hazardous;
  const worstAir = [...all].sort((a, b) => (todayOf(b)?.aqi ?? -1) - (todayOf(a)?.aqi ?? -1))[0];
  const dusty = all.filter((o) => (todayOf(o)?.dust ?? 0) >= DUST_HAZE).length;
  const dangerHeat = heat.danger + heat.extremeDanger;
  const hottest = [...all].sort((a, b) => (todayOf(b)?.feelsLikeMaxC ?? -99) - (todayOf(a)?.feelsLikeMaxC ?? -99))[0];
  const byAir = [...all].sort((a, b) => (b.maxAqi ?? -1) - (a.maxAqi ?? -1)).slice(0, 25);
  const byHeat = [...all].sort((a, b) => (b.maxFeelsLikeC ?? -99) - (a.maxFeelsLikeC ?? -99)).slice(0, 25);
  const updated = f.dateTime(new Date(all.map((o) => o.computedAt).sort().at(-1)!), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });

  return (
    <>
      <dl className="mt-10 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Districts with unhealthy air today" value={`${unhealthy} of ${all.length}`} sub={`${air.unhealthy + air.veryUnhealthy + air.hazardous} unhealthy for everyone`} alert={unhealthy > 0} />
        <Card
          label="Worst air today"
          value={worstAir && todayOf(worstAir)?.aqi != null ? `AQI ${todayOf(worstAir)!.aqi}` : "–"}
          sub={worstAir ? `${worstAir.district}${todayOf(worstAir)?.aqiLevel ? `, ${AQI_TEXT[todayOf(worstAir)!.aqiLevel!].label.toLowerCase()}` : ""}` : ""}
          alert={(todayOf(worstAir)?.aqi ?? 0) > 100}
        />
        <Card label="Harmattan dust in the air" value={`${dusty} districts`} sub={`dust above ${DUST_HAZE} µg/m³ at some hour today`} alert={dusty > 0} />
        <Card
          label="Districts with dangerous heat today"
          value={`${dangerHeat} of ${all.length}`}
          sub={hottest && todayOf(hottest)?.feelsLikeMaxC != null ? `hottest: ${hottest.district}, feels like ${Math.round(todayOf(hottest)!.feelsLikeMaxC!)} °C` : ""}
          alert={dangerHeat > 0}
        />
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">Forecast updated {updated}. Find your own district on its scorecard under <Link href="/districts" className="text-link underline">Districts</Link>.</p>

      <section className="mt-10" aria-labelledby="air-h">
        <h2 id="air-h" className="flex items-center gap-2 text-2xl font-semibold">
          Air quality
        </h2>
        <p className="mt-2 max-w-[75ch] text-sm text-muted-foreground">
          The worst hour of each day on the US Air Quality Index, which Ghana&apos;s EPA also uses, for the 25 districts with the worst air in the
          coming days. Fine particles (PM2.5) reach deep into the lungs; the World Health Organization advises a daily average below 15 µg/m³.
        </p>
        <div className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Air quality by district">
          <table className="gw-table w-full min-w-0 text-sm">
            <thead>
              <tr>
                <th>District</th>
                {days.map((d) => (
                  <th key={d} className="text-right">
                    {day(d)}
                  </th>
                ))}
                <th className="text-right">PM2.5 today</th>
                <th className="text-right">Dust today</th>
              </tr>
            </thead>
            <tbody>
              {byAir.map((o) => (
                <tr key={o.districtId}>
                  <td>
                    <Link href={`/districts/${o.slug}`} className="text-link underline">
                      {o.district}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{o.region?.replace(/ Region$/, "")}</span>
                  </td>
                  {days.map((d) => {
                    const x = o.days.find((y) => y.day === d);
                    return (
                      <td key={d} className="text-right">
                        {x?.aqi != null && x.aqiLevel ? (
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${AQI_CLS[x.aqiLevel]}`} title={AQI_TEXT[x.aqiLevel].label}>
                            {x.aqi}
                          </span>
                        ) : (
                          "–"
                        )}
                      </td>
                    );
                  })}
                  <td className="text-right tabular-nums">{todayOf(o)?.pm25 != null ? `${Math.round(todayOf(o)!.pm25!)} µg/m³` : "–"}</td>
                  <td className="text-right tabular-nums">{todayOf(o)?.dust != null ? `${todayOf(o)!.dust} µg/m³` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-12" aria-labelledby="heat-h">
        <h2 id="heat-h" className="flex items-center gap-2 text-2xl font-semibold">
          Heat
        </h2>
        <p className="mt-2 max-w-[75ch] text-sm text-muted-foreground">
          The highest feels-like temperature of each day, which adds the effect of humidity to the air temperature, for the 25 districts with the
          hottest days ahead. When the wet-bulb temperature reaches 28 °C the body can no longer cool itself well by sweating, and the level is
          raised to danger whatever the feels-like temperature.
        </p>
        <div className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Heat by district">
          <table className="gw-table w-full min-w-0 text-sm">
            <thead>
              <tr>
                <th>District</th>
                {days.slice(0, 3).map((d) => (
                  <th key={d} className="text-right">
                    {day(d)}
                  </th>
                ))}
                <th className="text-right">Air temperature today</th>
                <th className="text-right">Wet-bulb today</th>
              </tr>
            </thead>
            <tbody>
              {byHeat.map((o) => (
                <tr key={o.districtId}>
                  <td>
                    <Link href={`/districts/${o.slug}`} className="text-link underline">
                      {o.district}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{o.region?.replace(/ Region$/, "")}</span>
                  </td>
                  {days.slice(0, 3).map((d) => {
                    const x = o.days.find((y) => y.day === d);
                    return (
                      <td key={d} className="text-right">
                        {x?.feelsLikeMaxC != null && x.heatLevel ? (
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${HEAT_CLS[x.heatLevel]}`} title={HEAT_TEXT[x.heatLevel].label}>
                            {Math.round(x.feelsLikeMaxC)} °C
                          </span>
                        ) : (
                          "–"
                        )}
                      </td>
                    );
                  })}
                  <td className="text-right tabular-nums">{todayOf(o)?.tempMaxC != null ? `${Math.round(todayOf(o)!.tempMaxC!)} °C` : "–"}</td>
                  <td className="text-right tabular-nums">{todayOf(o)?.wetBulbMaxC != null ? `${todayOf(o)!.wetBulbMaxC} °C` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-12 grid gap-8 lg:grid-cols-2" aria-label="What the levels mean">
        <div>
          <h2 className="text-xl">What the air levels mean</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {AQI_LEVELS.map((l) => (
              <li key={l} className="flex gap-3">
                <span className={`mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${AQI_CLS[l]}`}>{AQI_TEXT[l].label}</span>
                <span>{AQI_TEXT[l].advice}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">0–50 good, 51–100 moderate, 101–150 unhealthy for sensitive groups, 151–200 unhealthy, 201–300 very unhealthy, above 300 hazardous.</p>
        </div>
        <div>
          <h2 className="text-xl">What the heat levels mean</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {HEAT_LEVELS.filter((l) => l !== "none").map((l) => (
              <li key={l} className="flex gap-3">
                <span className={`mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${HEAT_CLS[l]}`}>{HEAT_TEXT[l].label}</span>
                <span>{HEAT_TEXT[l].advice}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">Feels like 27–32 °C caution, 32–41 °C extreme caution, 41–54 °C danger, 54 °C or more extreme danger (US National Weather Service heat index).</p>
        </div>
      </section>

      <p className="mt-10 max-w-[80ch] text-xs text-muted-foreground">
        These are model forecasts for the centre of each district, not measurements: air quality from the Copernicus Atmosphere Monitoring Service
        global forecast (about 45 km across, so a busy road or a burning dump can be much worse than its district), heat from Open-Meteo. Generated
        using Copernicus Atmosphere Monitoring Service information; weather data by Open-Meteo.com.
      </p>
    </>
  );
}

function Card({ label, value, sub, alert }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className={`border-t-2 pt-2.5 ${alert ? "border-sev-elevated-fill" : "border-foreground/70"}`}>
      <dt className="text-[0.9375rem] text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 font-heading text-[1.75rem] font-semibold leading-tight tabular-nums ${alert ? "text-sev-elevated" : ""}`}>{value}</dd>
      <dd className="mt-1 text-sm text-muted-foreground">{sub}</dd>
    </div>
  );
}
