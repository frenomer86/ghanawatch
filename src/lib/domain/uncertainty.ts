/**
 * How sure the index is. Mapped hectares are what the scan drew; the estimate corrects them for the
 * share of drawn sites that turned out to be real (precision, from the random-sample checks) and the
 * share of real sites the scan drew at all (the detection rate, from the blind squares), in the manner
 * of Olofsson et al. (2014) but with two measured rates rather than a full confusion matrix. The
 * interval comes from Wilson 95% intervals on both rates, so a small sample never reads as certain.
 *
 * Pure functions, unit-tested; nothing here touches the database.
 */

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export interface RateSample {
  /** Correct (precision) or found (detection rate). */
  k: number;
  n: number;
}

export interface AreaEstimate {
  /** Hectares after correcting for false alarms and misses. */
  estimate: number;
  low: number;
  high: number;
  precision: number;
  detectionRate: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Corrected area for a mapped area. Without a detection-rate sample the estimate corrects for false
 * alarms only and says so (detectionRate null); the interval then reflects precision alone.
 * The detection rate is floored at 10% so a tiny blind sample cannot blow the estimate up.
 */
export function adjustedArea(mappedHa: number, precision: RateSample, detection?: RateSample | null): AreaEstimate {
  const p = precision.n > 0 ? precision.k / precision.n : 1;
  const [pLow, pHigh] = precision.n > 0 ? wilson(precision.k, precision.n) : [1, 1];
  if (!detection || detection.n <= 0) {
    return { estimate: round1(mappedHa * p), low: round1(mappedHa * pLow), high: round1(mappedHa * pHigh), precision: p, detectionRate: null };
  }
  const r = Math.max(0.1, detection.k / detection.n);
  const [rLowRaw, rHighRaw] = wilson(detection.k, detection.n);
  const rLow = Math.max(0.1, rLowRaw);
  const rHigh = Math.max(0.1, rHighRaw);
  return {
    estimate: round1((mappedHa * p) / r),
    low: round1((mappedHa * pLow) / rHigh),
    high: round1((mappedHa * pHigh) / rLow),
    precision: p,
    detectionRate: r,
  };
}
