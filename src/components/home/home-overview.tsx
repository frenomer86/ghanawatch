import { connection } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { homeStats } from "@/lib/db/repo/events";
import { getFreshness } from "@/lib/db/repo/sources";
import { SEVERITIES, type Locale } from "@/lib/domain/types";
import { severityFill } from "@/components/domain/severity-badge";
import { AlertTriangle } from "lucide-react";

/**
 * Live headline numbers. A stacked bar by risk level does the work a chart
 * would, with every value also printed, so nothing depends on colour.
 */
export async function HomeOverview({ locale }: { locale: Locale }) {
  await connection(); // live data: always rendered at request time, never in the static shell
  const now = new Date();
  const [stats, fresh] = await Promise.all([homeStats(now), getFreshness(now)]);
  const t = await getTranslations({ locale, namespace: "home" });
  const tSev = await getTranslations({ locale, namespace: "severity" });
  const f = await getFormatter({ locale });
  const total = Math.max(stats.newLast72h, 1);

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t("newLast72h")}</p>
        {fresh.lastSuccessfulRunAt && (
          <p className="text-xs text-muted-foreground">
            {t("lastUpdated")} {f.relativeTime(new Date(fresh.lastSuccessfulRunAt), now)}
          </p>
        )}
      </div>
      <p className="mt-1 font-heading text-5xl font-semibold tabular-nums leading-none">{f.number(stats.newLast72h)}</p>

      <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {SEVERITIES.map((s) =>
          stats.bySeverity[s] > 0 ? (
            <span key={s} style={{ width: `${(stats.bySeverity[s] / total) * 100}%`, background: severityFill[s] }} />
          ) : null,
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {SEVERITIES.map((s) => (
          <div key={s} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: severityFill[s] }} />
            <dt className="text-muted-foreground">{tSev(s)}</dt>
            <dd className="ml-auto font-medium tabular-nums">{f.number(stats.bySeverity[s])}</dd>
          </div>
        ))}
      </dl>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t pt-4 text-sm">
        <div>
          <dt className="text-muted-foreground">{t("activeHotspots")}</dt>
          <dd className="font-medium tabular-nums">
            {f.number(stats.districtsAffected30d)} <span className="font-normal text-muted-foreground">districts, 30 days</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("latestImage")}</dt>
          <dd className="font-medium tabular-nums">
            {fresh.latestImageDate ? f.dateTime(new Date(`${fresh.latestImageDate}T00:00:00Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "–"}
          </dd>
        </div>
      </dl>

      {fresh.isStale && (
        <p className="mt-4 flex items-start gap-2 rounded-md bg-sev-watch-tint p-3 text-sm text-sev-watch" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("stale")}
        </p>
      )}
    </div>
  );
}
