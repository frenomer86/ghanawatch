/**
 * Coastline change along Ghana's 550 km of coast, from Digital Earth Africa Coastlines (annual shorelines
 * from Landsat since 2000, tide-corrected; CC BY 4.0). Each point summarises the shoreline within about 1 km:
 * its rate of change in metres a year (negative is retreat, the sea moving inland), whether that trend is
 * statistically significant, and how far the shoreline has moved since 2000. Pure helpers for the page.
 */

export interface CoastPoint {
  lon: number;
  lat: number;
  /** Metres a year; negative is retreat. */
  rateMYr: number;
  /** p-value of the trend. */
  sig: number | null;
  certainty: string;
  /** Metres moved from 2000 to the latest year; negative is retreat. */
  changeM: number | null;
  latestYear: number | null;
  place: string | null;
  districtId: string | null;
}

/** A trend counts when it is significant (p < 0.01), the data are rated good, and the rate is at least 0.5 m a year. */
export function isSignificant(p: Pick<CoastPoint, "sig" | "certainty" | "rateMYr">): boolean {
  return p.sig != null && p.sig < 0.01 && p.certainty === "good" && Math.abs(p.rateMYr) >= 0.5;
}

export function coastLevel(rateMYr: number): "severe" | "high" | "moderate" | "low" | "growing" {
  return rateMYr <= -5 ? "severe" : rateMYr <= -2 ? "high" : rateMYr <= -0.5 ? "moderate" : rateMYr >= 0.5 ? "growing" : "low";
}

const km = (a: CoastPoint, b: CoastPoint) => {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};

/** The strongest points first, keeping only those at least `spacingKm` from a stronger one already kept. */
export function strongestStretches<T extends CoastPoint>(points: T[], sign: -1 | 1, n: number, spacingKm = 4): T[] {
  const cands = points.filter((p) => isSignificant(p) && Math.sign(p.rateMYr) === sign).sort((a, b) => sign * (b.rateMYr - a.rateMYr));
  const out: T[] = [];
  for (const p of cands) {
    if (out.length >= n) break;
    if (out.every((q) => km(p, q) >= spacingKm)) out.push(p);
  }
  return out;
}

export function coastTotals(points: CoastPoint[]) {
  const sig = points.filter(isSignificant);
  return {
    measured: points.length,
    retreating: sig.filter((p) => p.rateMYr < 0).length,
    growing: sig.filter((p) => p.rateMYr > 0).length,
    severe: sig.filter((p) => p.rateMYr <= -2).length,
  };
}
