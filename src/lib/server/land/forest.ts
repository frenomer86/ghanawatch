import type { Plot } from "./plot";
import { samplePlotTiles } from "./tiles";

/**
 * Forest history of a plot from Global Forest Watch's public, keyless tiles.
 *
 * Tree cover loss (Hansen/UMD/Google/USGS/NASA, 30 m, yearly since 2001):
 * the blue channel carries the year of loss minus 2000, for canopy that was at
 * least 30% tree cover. Integrated deforestation alerts (GLAD-L, GLAD-S2,
 * RADD; 10 to 30 m, weekly): red and green carry the alert date as days since
 * 2014-12-31, blue the confidence in its hundreds, alpha which systems agree.
 */
const LOSS_URL = (z: number, x: number, y: number) =>
  `https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/${z}/${x}/${y}.png?implementation=tcd_30`;
const ALERTS_URL = (z: number, x: number, y: number) => `https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/default/${z}/${x}/${y}.png`;

const ALERT_EPOCH = Date.UTC(2014, 11, 31);
const ha = (m2: number) => m2 / 10_000;
const round = (v: number) => Math.round(v * 100) / 100;

export interface ForestLoss {
  byYear: Record<string, number>;
  totalHa: number;
  since2020Ha: number;
  version: string | null;
  complete: boolean;
}

export interface ForestAlerts {
  byYear: Record<string, number>;
  since2020Ha: number;
  highConfidenceHa: number;
  latest: string | null;
  version: string | null;
  complete: boolean;
}

export function decodeLossYear(r: number, b: number): number | null {
  if (r === 0 || b < 1 || b > 60) return null;
  return 2000 + b;
}

export function decodeAlert(r: number, g: number, b: number, a: number): { date: string; confidence: number } | null {
  if (a === 0) return null;
  const day = r * 255 + g;
  if (day <= 0) return null;
  return { date: new Date(ALERT_EPOCH + day * 86_400_000).toISOString().slice(0, 10), confidence: Math.max(0, Math.floor(b / 100) - 1) };
}

export async function forestLoss(plot: Plot): Promise<ForestLoss> {
  const byYear: Record<string, number> = {};
  const res = await samplePlotTiles(LOSS_URL, 13, plot, (r, _g, b, _a, area) => {
    const year = decodeLossYear(r, b);
    if (year) byYear[year] = (byYear[year] ?? 0) + ha(area);
  });
  for (const y of Object.keys(byYear)) byYear[y] = round(byYear[y]);
  const total = Object.values(byYear).reduce((s, v) => s + v, 0);
  const since = Object.entries(byYear).reduce((s, [y, v]) => (Number(y) >= 2020 ? s + v : s), 0);
  return {
    byYear,
    totalHa: round(total),
    since2020Ha: round(since),
    version: res.finalUrl?.match(/umd_tree_cover_loss\/(v[\d.]+)\//)?.[1] ?? null,
    complete: res.failed === 0,
  };
}

export async function forestAlerts(plot: Plot): Promise<ForestAlerts> {
  const byYear: Record<string, number> = {};
  let high = 0;
  let latest: string | null = null;
  const res = await samplePlotTiles(ALERTS_URL, 14, plot, (r, g, b, a, area) => {
    const alert = decodeAlert(r, g, b, a);
    if (!alert || alert.date < "2020-01-01") return;
    const y = alert.date.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + ha(area);
    if (alert.confidence >= 1) high += ha(area);
    if (!latest || alert.date > latest) latest = alert.date;
  });
  for (const y of Object.keys(byYear)) byYear[y] = round(byYear[y]);
  return {
    byYear,
    since2020Ha: round(Object.values(byYear).reduce((s, v) => s + v, 0)),
    highConfidenceHa: round(high),
    latest,
    version: res.finalUrl?.match(/gfw_integrated_alerts\/(v\d+)\//)?.[1] ?? null,
    complete: res.failed === 0,
  };
}
