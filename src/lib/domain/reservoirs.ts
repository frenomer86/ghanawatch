/**
 * Ghana's main reservoirs and lakes, watched by radar for how much of each is under water. The outlines are
 * Digital Earth Africa Waterbodies polygons (Landsat, 1984 onward, CC BY 4.0): the largest extent each water
 * body has reached, identified here by its `wb_id`. Pure helpers for the water threshold and the summaries the
 * page shows; the pipeline adapter (src/pipeline/adapters/reservoirs.ts) does the reading.
 */

export interface ReservoirDef {
  slug: string;
  name: string;
  /** Digital Earth Africa Waterbodies identifier. */
  wbId: number;
  /** What the water is used for. */
  use: string;
  region: string;
  /** Radar grid resolution, metres: coarser for the largest. */
  resM: number;
}

export const RESERVOIRS: ReservoirDef[] = [
  { slug: "volta", name: "Lake Volta", wbId: 30476, use: "Akosombo and Kpong hydropower, fishing, lake transport and irrigation", region: "Eastern, Volta, Oti, Bono East, Northern, Savannah", resM: 200 },
  { slug: "bui", name: "Bui Reservoir", wbId: 30409, use: "Bui hydropower station (404 MW) and irrigation", region: "Bono, Savannah", resM: 60 },
  { slug: "kpong", name: "Kpong Reservoir", wbId: 507581, use: "Kpong hydropower and the Kpong waterworks that supply much of Accra and Tema", region: "Eastern", resM: 40 },
  { slug: "bosomtwe", name: "Lake Bosomtwe", wbId: 29727, use: "Natural crater lake; fishing and tourism", region: "Ashanti", resM: 30 },
  { slug: "weija", name: "Weija Reservoir", wbId: 16930, use: "Drinking water for western Accra and Kasoa", region: "Greater Accra, Central", resM: 20 },
  { slug: "barekese", name: "Barekese Reservoir", wbId: 29758, use: "Drinking water for Kumasi", region: "Ashanti", resM: 20 },
  { slug: "owabi", name: "Owabi Reservoir", wbId: 29757, use: "Drinking water for Kumasi; wildlife sanctuary", region: "Ashanti", resM: 20 },
  { slug: "tono", name: "Tono Reservoir", wbId: 33844, use: "Irrigation for the Tono scheme near Navrongo", region: "Upper East", resM: 20 },
  { slug: "vea", name: "Vea Reservoir", wbId: 33920, use: "Irrigation and Bolgatanga's water supply", region: "Upper East", resM: 20 },
  { slug: "dawhenya", name: "Dawhenya Reservoir", wbId: 507243, use: "Rice irrigation", region: "Greater Accra", resM: 20 },
  { slug: "songor", name: "Songor Lagoon", wbId: 507411, use: "Ramsar wetland; salt winning and fishing", region: "Greater Accra", resM: 20 },
];

/**
 * VH (cross-polarised) backscatter below which a pixel is open water: Otsu's threshold, kept within these
 * bounds. VH is used rather than VV because wind roughens open water far more in VV: on Lake Bosomtwe in
 * November and December 2025, VV put 75% to 96% of the lake under water from pass to pass, VH 91% to 93%.
 */
export const WATER_DB = { min: -28, max: -16, fallback: -22 } as const;

/**
 * Otsu's threshold on VH backscatter (dB) over a water body's largest extent and a band of land around it, so
 * that the histogram always holds both open water (dark) and land (bright), whatever the satellite, orbit and
 * incidence angle. When it is still not bimodal enough the fixed threshold is used instead.
 */
export function waterThreshold(values: ArrayLike<number>): number {
  const lo = -30;
  const hi = 5;
  const bins = 140;
  const hist = new Float64Array(bins);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * bins)));
    hist[b]++;
    n++;
  }
  if (n < 50) return WATER_DB.fallback;
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let bestB = -1;
  let total = 0;
  const mean = sumAll / n;
  for (let b = 0; b < bins; b++) total += hist[b] * (b - mean) ** 2;
  for (let b = 0; b < bins - 1; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestB = b;
    }
  }
  const t = lo + ((bestB + 1) / bins) * (hi - lo);
  // Separability (between-class over total variance): a single bell-shaped mode scores 2/π ≈ 0.64, so below
  // 0.7 there are not two distinct classes.
  const eta = total > 0 ? best / n / (total / n) / n : 0;
  if (!(eta >= 0.7) || t < WATER_DB.min || t > WATER_DB.max) return WATER_DB.fallback;
  return Math.round(t * 10) / 10;
}

export interface ReservoirObservation {
  date: string;
  waterKm2: number;
  /** Share of the largest extent under water, %. */
  waterPct: number;
  /** Share of the largest extent the radar saw, %. */
  observedPct: number;
}

export interface ReservoirSummary {
  latest: ReservoirObservation | null;
  /** The observation nearest to 30 days before the latest (20 to 45 days back). */
  monthAgo: ReservoirObservation | null;
  /** The observation nearest to a year before the latest (within 20 days). */
  yearAgo: ReservoirObservation | null;
  /** Change in percentage points. */
  changeMonth: number | null;
  changeYear: number | null;
  trend: "rising" | "falling" | "steady" | null;
}

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);

const med3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
 * A running median of three passes (the last point takes the median of the last three), which removes the
 * single-pass dips that wind on open water causes while keeping real rises and falls, which last for weeks.
 */
export function smoothed(obs: ReservoirObservation[]): ReservoirObservation[] {
  const s = [...obs].sort((a, b) => a.date.localeCompare(b.date));
  return s.map((o, i) => {
    const trio = i === 0 ? null : i === s.length - 1 ? (s.length >= 3 ? [s[i - 2], s[i - 1], o] : null) : [s[i - 1], o, s[i + 1]];
    if (!trio) return o;
    const pct = med3(trio[0].waterPct, trio[1].waterPct, trio[2].waterPct);
    const km2 = med3(trio[0].waterKm2, trio[1].waterKm2, trio[2].waterKm2);
    return { ...o, waterPct: pct, waterKm2: km2 };
  });
}

/** Latest state and change, from the smoothed series of observations in any order. Changes under 2 points are "steady". */
export function summarise(obs: ReservoirObservation[]): ReservoirSummary {
  const s = smoothed(obs);
  const latest = s.at(-1) ?? null;
  if (!latest) return { latest: null, monthAgo: null, yearAgo: null, changeMonth: null, changeYear: null, trend: null };
  const near = (days: number, tolLo: number, tolHi: number) => {
    const target = t(latest.date) - days * DAY;
    let best: ReservoirObservation | null = null;
    for (const o of s) {
      const d = (t(latest.date) - t(o.date)) / DAY;
      if (d < tolLo || d > tolHi) continue;
      if (!best || Math.abs(t(o.date) - target) < Math.abs(t(best.date) - target)) best = o;
    }
    return best;
  };
  const monthAgo = near(30, 20, 45);
  const yearAgo = near(365, 345, 385);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const changeMonth = monthAgo ? r1(latest.waterPct - monthAgo.waterPct) : null;
  const changeYear = yearAgo ? r1(latest.waterPct - yearAgo.waterPct) : null;
  const trend = changeMonth == null ? null : changeMonth >= 2 ? "rising" : changeMonth <= -2 ? "falling" : "steady";
  return { latest, monthAgo, yearAgo, changeMonth, changeYear, trend };
}
