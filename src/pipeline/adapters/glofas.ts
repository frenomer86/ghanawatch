import { squareAround } from "@/lib/geo";
import type { Adapter, NormalisedEvent } from "./types";

/**
 * Copernicus GloFAS river discharge forecasts for Ghanaian rivers, read through
 * the keyless Open-Meteo Flood API (https://open-meteo.com/en/docs/flood-api),
 * which serves GloFAS v4 at 5 km resolution: a daily reanalysis back to 1984
 * and a 30-day ensemble forecast.
 *
 * For each monitoring point the adapter:
 *  1. reads 2001 to yesterday of daily discharge and takes the maximum of each
 *     calendar year (the annual-maximum series);
 *  2. sets the 2-year threshold to the median of those annual maxima and the
 *     5-year threshold to their 80th percentile (empirical return levels);
 *  3. reads the next 10 days of forecast discharge (ensemble median and max);
 *  4. creates a flood-risk record only when the forecast median reaches the
 *     2-year threshold. Severity: 2-year = watch, 5-year = elevated, above the
 *     highest annual maximum on record = urgent. Below threshold, no record.
 *
 * Thresholds are recomputed each run, so they follow the GloFAS reanalysis.
 */
export const RIVER_POINTS = [
  { id: "WV-PWALUGU", name: "Pwalugu", river: "White Volta", lat: 10.5872, lon: -0.8503 },
  { id: "WV-NAWUNI", name: "Nawuni", river: "White Volta", lat: 9.7006, lon: -1.0912 },
  { id: "WV-DABOYA", name: "Daboya", river: "White Volta", lat: 9.5319, lon: -1.3836 },
  { id: "BV-BUI", name: "Bui", river: "Black Volta", lat: 8.2789, lon: -2.2364 },
  { id: "BV-BAMBOI", name: "Bamboi", river: "Black Volta", lat: 8.1489, lon: -2.0331 },
  { id: "OTI-SABARI", name: "Sabari", river: "Oti", lat: 9.2778, lon: 0.2356 },
  { id: "SIS-NABOGO", name: "Nabogo", river: "Nasia", lat: 10.1200, lon: -0.8600 },
  { id: "LV-SOGAKOPE", name: "Sogakope", river: "Lower Volta", lat: 6.0036, lon: 0.6012 },
  { id: "PRA-DABOASE", name: "Daboase", river: "Pra", lat: 5.1644, lon: -1.6281 },
  { id: "PRA-TWIFO", name: "Twifo Praso", river: "Pra", lat: 5.6111, lon: -1.5500 },
  { id: "OFF-DUNKWA", name: "Dunkwa-on-Offin", river: "Offin", lat: 5.9606, lon: -1.7806 },
  { id: "BIR-ODA", name: "Akim Oda", river: "Birim", lat: 5.9283, lon: -0.9856 },
  { id: "ANK-PRESTEA", name: "Prestea", river: "Ankobra", lat: 5.4333, lon: -2.1431 },
  { id: "TANO-ALENDA", name: "Alenda", river: "Tano", lat: 5.3700, lon: -2.6900 },
  { id: "DENSU-MANKESSIM", name: "Weija", river: "Densu", lat: 5.5800, lon: -0.3400 },
  { id: "AFRAM-EKYE", name: "Ekye Amanfrom", river: "Afram", lat: 6.6900, lon: -0.5600 },
];

interface FloodResponse {
  daily?: { time: string[]; river_discharge?: (number | null)[]; river_discharge_median?: (number | null)[]; river_discharge_max?: (number | null)[] };
}

export interface PointStatus {
  id: string;
  name: string;
  river: string;
  peak: number;
  peakDate: string;
  t2: number;
  t5: number;
  recordMax: number;
  ratio2: number;
}

export const glofasAdapter: Adapter = {
  slug: "copernicus-glofas",
  async run(ctx) {
    const today = ctx.now.toISOString().slice(0, 10);
    const yesterday = new Date(ctx.now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const events: NormalisedEvent[] = [];
    const statuses: PointStatus[] = [];
    const notes: string[] = [];
    for (const p of RIVER_POINTS) {
      // Open-Meteo is free and keyless; pace requests so the fair-use limit is respected.
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const hist = await ctx.fetchJson<FloodResponse>(
          `https://flood-api.open-meteo.com/v1/flood?latitude=${p.lat}&longitude=${p.lon}&daily=river_discharge&start_date=2001-01-01&end_date=${yesterday}`,
        );
        const fc = await ctx.fetchJson<FloodResponse>(
          `https://flood-api.open-meteo.com/v1/flood?latitude=${p.lat}&longitude=${p.lon}&daily=river_discharge_median,river_discharge_max&forecast_days=10`,
        );
        const annual = annualMaxima(hist.daily?.time ?? [], hist.daily?.river_discharge ?? []);
        if (annual.length < 10) {
          notes.push(`${p.name}: not enough history`);
          continue;
        }
        const t2 = quantile(annual, 0.5);
        const t5 = quantile(annual, 0.8);
        const recordMax = Math.max(...annual);
        const times = fc.daily?.time ?? [];
        const med = fc.daily?.river_discharge_median ?? [];
        const max = fc.daily?.river_discharge_max ?? [];
        let peak = -1;
        let peakIdx = -1;
        med.forEach((v, i) => {
          if (v != null && v > peak) {
            peak = v;
            peakIdx = i;
          }
        });
        if (peakIdx < 0) continue;
        const ensMax = Math.max(...max.filter((v): v is number => v != null));
        statuses.push({ id: p.id, name: p.name, river: p.river, peak, peakDate: times[peakIdx], t2, t5, recordMax, ratio2: peak / t2 });
        if (peak < t2) continue;
        const severity = peak > recordMax ? "urgent" : peak >= t5 ? "elevated" : "watch";
        const leadDays = Math.round((new Date(`${times[peakIdx]}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
        const confidence = leadDays <= 3 ? "high" : leadDays <= 6 ? "medium" : "low";
        events.push({
          sourceSlug: "copernicus-glofas",
          sourceEventId: `${today}-${p.id}`,
          type: "flood_risk",
          detectedAt: ctx.now,
          imageDate: today,
          imageDateEnd: times[peakIdx],
          confidence,
          confidenceScore: confidence === "high" ? 0.85 : confidence === "medium" ? 0.65 : 0.45,
          severity,
          areaHa: null,
          geom: squareAround({ lon: p.lon, lat: p.lat }, 3000),
          titleEn: `Flood risk on the ${p.river} near ${p.name}`,
          titleTw: `Nsuyire asiane wɔ ${p.river} so, ${p.name} nkyɛn`,
          descriptionEn: `GloFAS forecast (issued ${today}) shows river discharge peaking at about ${Math.round(peak)} m³/s on ${times[peakIdx]}, against a 2-year level of ${Math.round(t2)} m³/s and a 5-year level of ${Math.round(t5)} m³/s derived from the 2001–${yesterday.slice(0, 4)} GloFAS record. The wettest ensemble member reaches ${Math.round(ensMax)} m³/s. This is a model forecast at 5 km resolution, not an observed flood.`,
          descriptionTw: "GloFAS nkɔmhyɛ kyerɛ sɛ nsuo dodoɔ bɛkɔ soro wɔ nna a ɛreba yi mu. Ɛyɛ nkɔmhyɛ, ɛnyɛ nsuyire a aba dada.",
          methodVersion: "glofas-openmeteo-1.0",
          properties: { point: p.id, river: p.river, peak, peakDate: times[peakIdx], t2, t5, recordMax, ensembleMax: ensMax },
        });
      } catch (err) {
        notes.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (statuses.length === 0) throw new Error(`No river point could be read. ${notes.slice(0, 3).join("; ")}`);
    ctx.log(
      `copernicus-glofas: ${statuses.length} rivers checked, ${events.length} above the 2-year level. ` +
        statuses.map((s) => `${s.name} ${Math.round(s.ratio2 * 100)}%`).join(", "),
    );
    return { events, watermark: ctx.now, notes, extra: { statuses } };
  },
};

function annualMaxima(times: string[], values: (number | null)[]): number[] {
  const byYear = new Map<string, number>();
  times.forEach((t, i) => {
    const v = values[i];
    if (v == null) return;
    const y = t.slice(0, 4);
    byYear.set(y, Math.max(byYear.get(y) ?? -Infinity, v));
  });
  const thisYear = new Date().getUTCFullYear().toString();
  byYear.delete(thisYear); // incomplete year
  return [...byYear.values()];
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
