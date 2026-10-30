import { connection } from "next/server";
import { getFormatter } from "next-intl/server";
import { latestRiverLevels } from "@/lib/db/repo/sources";
import type { Locale } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

/**
 * Forecast peak river discharge at each monitoring point as a share of its
 * 2-year flood level (GloFAS via Open-Meteo). Shown even when nothing is in
 * alert, so people can see the rivers are being watched and how close they are.
 */
export async function RiverWatch({ locale, compact = false }: { locale: Locale; compact?: boolean }) {
  await connection();
  const { checkedAt, levels } = await latestRiverLevels();
  const f = await getFormatter({ locale });
  if (!levels.length) {
    return (
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-lg font-semibold">River watch</h2>
        <p className="mt-2 text-sm text-muted-foreground">River forecasts have not been fetched yet.</p>
      </section>
    );
  }
  const shown = compact ? levels.slice(0, 6) : levels;
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="river-watch-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="river-watch-h" className="text-lg font-semibold">
          River watch
        </h2>
        {checkedAt && (
          <p className="text-xs text-muted-foreground">
            Forecast checked {f.dateTime(new Date(checkedAt), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" })}
          </p>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Highest forecast flow in the next 10 days, as a share of each river&apos;s 2-year flood level. A flood-risk alert is raised at 100%.
      </p>
      <ul className="mt-4 space-y-3">
        {shown.map((l) => {
          const pct = Math.round(l.ratio2 * 100);
          const level = l.peak > l.recordMax ? "urgent" : l.peak >= l.t5 ? "elevated" : l.peak >= l.t2 ? "watch" : "normal";
          return (
            <li key={l.id}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">{l.river}</span> <span className="text-muted-foreground">at {l.name}</span>
                </span>
                <span className="tabular-nums">
                  {pct}% <span className="text-muted-foreground">· {Math.round(l.peak)} m³/s</span>
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${l.river} at ${l.name}: ${pct}% of the 2-year flood level`}>
                <div
                  className={cn(
                    "h-full rounded-full",
                    level === "normal" && "bg-river-600",
                    level === "watch" && "bg-sev-watch-fill",
                    level === "elevated" && "bg-sev-elevated-fill",
                    level === "urgent" && "bg-sev-urgent-fill",
                  )}
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {compact && levels.length > shown.length && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the {shown.length} highest of {levels.length} monitored rivers.
        </p>
      )}
    </section>
  );
}
