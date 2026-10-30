"use client";

import useSWR from "swr";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { AlertTriangle, WifiOff } from "lucide-react";
import { fetcher } from "@/lib/client/fetcher";
import type { DataFreshness } from "@/lib/domain/types";
import { cn } from "@/lib/utils";
import { useOnline } from "@/lib/client/use-online";

type Payload = DataFreshness & { stats: { newLast72h: number } };

/** "Updated 2 hours ago, latest image 11 Oct" plus a stale or offline notice. */
export function FreshnessChip({ className }: { className?: string }) {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const f = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const online = useOnline();
  const { data, error } = useSWR<Payload>("/api/v1/freshness", fetcher, { refreshInterval: 5 * 60_000 });
  if (error && !data) return null;
  const offline = !online;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card/95 px-3 py-2 text-xs shadow-sm backdrop-blur", className)}>
      {data ? (
        <>
          <span className="font-medium text-foreground">
            {t("newLast72h")}: <span className="tabular-nums">{data.stats.newLast72h}</span>
          </span>
          <span className="text-muted-foreground">
            {t("lastUpdated")}{" "}
            {data.lastSuccessfulRunAt ? f.relativeTime(new Date(data.lastSuccessfulRunAt), now) : "–"}
          </span>
          {data.latestImageDate && (
            <span className="text-muted-foreground">
              {t("latestImage")} {f.dateTime(new Date(`${data.latestImageDate}T00:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" })}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">{tc("loading")}</span>
      )}
      {(data?.isStale || offline) && (
        <span className="flex basis-full items-center gap-1.5 text-sev-watch" role="status">
          {offline ? <WifiOff className="size-3.5" aria-hidden /> : <AlertTriangle className="size-3.5" aria-hidden />}
          {offline ? tc("offline") : t("stale")}
        </span>
      )}
    </div>
  );
}
