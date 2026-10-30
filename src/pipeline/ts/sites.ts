import { monthName, type TrackerState } from "./tracker";

/**
 * Sites from the tracker: 8-connected groups of pixels that count as mined now, with their dated history.
 * Pure (grid in, sites out) and unit-tested.
 */
export interface TsSite {
  /** Pixel indices (state grid). */
  pixels: number[];
  areaHa: number;
  /** Earliest onset among a robust share of the site's pixels (10th percentile), YYYY-MM. */
  onset: string;
  /** Mined area by onset month (YYYY-MM -> ha). */
  onsetHa: Record<string, number>;
  /** Area confirmed as mined in the month just processed (ha) and the onset months of those pixels. */
  newlyConfirmedHa: number;
  newlyOnsetHa: Record<string, number>;
  /** Mean P(mined) over the site. */
  meanP: number;
  /** Mean number of months with an observation. */
  meanObserved: number;
  /** Mined area whose onset is within the last three months: the site is spreading. */
  expandingHa: number;
  /** Pixel index of the anchor: the centre of the site's earliest pixels, stable as the site grows. */
  anchor: number;
}

export const MIN_SITE_PX_HA = 0.3;

export function extractSites(s: TrackerState, width: number, height: number, res: number, confirmedBefore: Int16Array | null, threshold = 0.5): TsSite[] {
  const n = width * height;
  const pxHa = (res * res) / 10_000;
  const mined = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (s.p1[i] >= threshold) mined[i] = 1;
  const seen = new Uint8Array(n);
  const out: TsSite[] = [];
  const stack: number[] = [];
  const month = s.lastMonth;
  for (let start = 0; start < n; start++) {
    if (!mined[start] || seen[start]) continue;
    const pixels: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      pixels.push(q);
      const x = q % width;
      const y = (q - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const k = yy * width + xx;
          if (mined[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    if (pixels.length * pxHa < MIN_SITE_PX_HA) continue;
    const onsets = pixels.map((p) => s.onset[p]).filter((o) => o >= 0).sort((a, b) => a - b);
    if (!onsets.length) continue;
    const onsetHa: Record<string, number> = {};
    const newlyOnsetHa: Record<string, number> = {};
    let newly = 0;
    let sumP = 0;
    let sumObs = 0;
    let expanding = 0;
    for (const p of pixels) {
      const o = s.onset[p];
      if (o >= 0) {
        const m = monthName(o);
        onsetHa[m] = (onsetHa[m] ?? 0) + pxHa;
        if (month - o <= 2) expanding += pxHa;
        if (confirmedBefore && confirmedBefore[p] < 0) {
          newly += pxHa;
          newlyOnsetHa[m] = (newlyOnsetHa[m] ?? 0) + pxHa;
        }
      }
      sumP += s.p1[p];
      sumObs += s.observed[p];
    }
    const onset10 = onsets[Math.floor(onsets.length * 0.1)];
    // Anchor: centre of the pixels whose onset is at or before the 10th-percentile onset.
    let ax = 0, ay = 0, an = 0;
    for (const p of pixels) {
      if (s.onset[p] >= 0 && s.onset[p] <= onset10) {
        ax += p % width;
        ay += Math.floor(p / width);
        an++;
      }
    }
    const anchor = Math.round(ay / an) * width + Math.round(ax / an);
    const round = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).sort().map(([k, v]) => [k, Math.round(v * 100) / 100]));
    out.push({
      pixels,
      areaHa: Math.round(pixels.length * pxHa * 100) / 100,
      onset: monthName(onset10),
      onsetHa: round(onsetHa),
      newlyConfirmedHa: Math.round(newly * 100) / 100,
      newlyOnsetHa: round(newlyOnsetHa),
      meanP: sumP / pixels.length,
      meanObserved: sumObs / pixels.length,
      expandingHa: Math.round(expanding * 100) / 100,
      anchor,
    });
  }
  return out;
}

/** Convex hull (monotone chain), closed, of the pixel squares of a site, in grid metres. */
export function siteHull(pixels: number[], width: number, bbox: [number, number, number, number], res: number): [number, number][] {
  const pts: [number, number][] = [];
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    const mx = bbox[0] + x * res;
    const my = bbox[3] - y * res;
    pts.push([mx, my], [mx + res, my], [mx, my - res], [mx + res, my - res]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  h.push(h[0]);
  return h;
}
