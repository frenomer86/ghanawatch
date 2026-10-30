import type { LandChange, LandSummary } from "@/lib/domain/land";
import { TtlCache } from "@/lib/server/explore/cache";
import { annualYears } from "@/lib/server/explore/mosaics";
import { highResCaptures } from "@/lib/server/explore/wayback";
import { plotChange } from "./change";
import { plotContext } from "./context";
import { plotFires } from "./fires";
import { forestAlerts, forestLoss } from "./forest";
import { forest2020 } from "./forest2020";
import { circlePlot, type Plot } from "./plot";

/**
 * "Check this land": everything public data can say about a plot since 2020,
 * gathered in parallel. A source that fails is left out with a note rather
 * than guessed. Results are cached per plot for six hours.
 */
const summaries = new TtlCache<LandSummary>(300, 6 * 3_600_000);
const changes = new TtlCache<LandChange>(300, 24 * 3_600_000);

/** Plots are keyed to 4 decimals (about 11 m) so near-identical requests share one answer and cannot be used to force a fresh fetch each time. */
export const plotKey = (p: Plot) => `${p.center.lat.toFixed(4)},${p.center.lon.toFixed(4)},${p.radiusM}`;

export function makePlot(lat: number, lon: number, radiusM: number): Plot {
  return circlePlot(Number(lon.toFixed(4)), Number(lat.toFixed(4)), radiusM);
}

export async function landSummary(plot: Plot): Promise<LandSummary> {
  return summaries.get(plotKey(plot), async () => {
    const notes: string[] = [];
    const soft = <T,>(label: string, p: Promise<T>): Promise<T | null> =>
      p.catch((e: unknown) => {
        notes.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
    const [context, loss, alerts, fires, captures, years, forest] = await Promise.all([
      plotContext(plot),
      soft("Tree cover loss", forestLoss(plot)),
      soft("Deforestation alerts", forestAlerts(plot)),
      soft("Fire record", plotFires(plot)),
      soft("High-resolution imagery", highResCaptures(plot.center.lon, plot.center.lat)),
      soft("Yearly mosaics", annualYears()),
      soft("EU 2020 forest map", forest2020(plot)),
    ]);
    const after2020 = (rec: Record<string, number> | undefined) => (rec ? Object.entries(rec).filter(([y]) => Number(y) >= 2021).reduce((a, [, v]) => a + v, 0) : null);
    const lossAfter = after2020(loss?.byYear);
    const alertsAfter = after2020(alerts?.byYear);
    const eudr = forest
      ? {
          forest2020Ha: forest.forestHa,
          forest2020Share: forest.share,
          lossAfter2020Ha: lossAfter == null ? null : Math.round(lossAfter * 100) / 100,
          alertsAfter2020Ha: alertsAfter == null ? null : Math.round(alertsAfter * 100) / 100,
          finding: (forest.share < 0.01 ? "no-forest-2020" : (lossAfter ?? 0) >= 0.05 || (alertsAfter ?? 0) >= 0.05 ? "forest-loss-seen" : "forest-no-loss-seen") as
            | "no-forest-2020"
            | "forest-no-loss-seen"
            | "forest-loss-seen",
          version: forest.version,
        }
      : null;
    const newest = captures?.[0];
    return {
      plot: { lat: plot.center.lat, lon: plot.center.lon, radiusM: plot.radiusM, areaHa: Math.round(plot.areaHa * 100) / 100 },
      place: { district: context.district, region: context.region },
      protectedArea: context.protectedArea,
      detectionsOnPlot: context.detectionsOnPlot,
      nearestGalamsey: context.nearestGalamsey,
      forestLoss: loss,
      alerts,
      eudr,
      fires,
      closeUp: newest ? { capturedOn: newest.capturedOn, sensor: newest.sensor, provider: newest.provider, resolutionM: newest.resolutionM, release: newest.release } : null,
      mosaicYears: years?.length ? { first: years.includes(2020) ? 2020 : years[0], latest: years[years.length - 1] } : null,
      generatedAt: new Date().toISOString(),
      notes,
    };
  });
}

export async function landChange(plot: Plot): Promise<LandChange> {
  return changes.get(plotKey(plot), () => plotChange(plot));
}
