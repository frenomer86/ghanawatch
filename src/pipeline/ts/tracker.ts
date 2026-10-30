/**
 * Per-pixel temporal tracker: a three-state hidden Markov model over the model's monthly mining
 * probabilities.
 *
 *   0 not mined   — never mined since the series began
 *   1 mined       — a mining footprint is on the ground (pits, ponds, spoil, cleared works)
 *   2 regrown     — was mined, now covered by vegetation again (reclaimed or abandoned and overgrown)
 *
 * Each month the state probabilities are moved forward with the transition matrix, then multiplied by
 * the evidence of that month: the model's probability turned into a likelihood ratio against its training
 * prior, tempered by how far one month of that sensor can be trusted (a Sentinel-2 month counts more than
 * a radar-only month; errors in consecutive months are not independent, so no month counts fully). A month
 * with no observation at all simply passes. This is what turns one flickering monthly map into a dated
 * history: a pixel becomes "mined" only once the evidence has built up, and a single cloudy or hazy month
 * cannot create or erase a site.
 *
 * Onset: the first month of the run of mining-looking observations that carried the pixel over the
 * threshold. It is fixed once set, so a closed month of the index never changes.
 */
export const NOT = 0;
export const MINED = 1;
export const REGROWN = 2;

/** How a month's value for a pixel was observed. */
export const REGIME = { none: 0, sentinel2: 1, landsat: 2, radar: 3 } as const;
export type Regime = (typeof REGIME)[keyof typeof REGIME];

export interface TrackerParams {
  /** Monthly chance an unmined pixel becomes mined. */
  onset: number;
  /** Monthly chance a mined pixel regrows. */
  regrow: number;
  /** Monthly chance a regrown pixel is mined again. */
  remine: number;
  /** P(mined) at the start of the series (mining that predates it). */
  initialMined: number;
  /** The model's probability of mining when it knows nothing (its training base rate). */
  modelPrior: number;
  /** Evidence weight of one month, by regime. */
  weight: Record<Exclude<Regime, 0>, number>;
  /** P(mined) at or above which a pixel counts as mined. */
  threshold: number;
  /** Probability clamp, so one month can never be certain. */
  clamp: number;
}

export const DEFAULT_PARAMS: TrackerParams = {
  onset: 0.002,
  regrow: 0.01,
  remine: 0.03,
  initialMined: 0.02,
  modelPrior: 0.08,
  // Chosen on validation blocks b1_4 and b2_5 (research/eval/tracker_sweep.py), never on the test blocks: the
  // highest IoU among settings where one month, however confident, cannot confirm a pixel and two months can.
  weight: { 1: 0.7, 2: 0.6, 3: 0.35 },
  threshold: 0.7,
  clamp: 0.02,
};

/** Month index since 2013-01 (Landsat 8's first full year), so a month fits in an Int16. */
export const EPOCH = 2013;
export const monthIndex = (m: string) => (Number(m.slice(0, 4)) - EPOCH) * 12 + Number(m.slice(5, 7)) - 1;
export const monthName = (i: number) => `${EPOCH + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;

export interface TrackerState {
  n: number;
  /** Probabilities of the three states after the last month processed. */
  p0: Float32Array;
  p1: Float32Array;
  p2: Float32Array;
  /** First month (monthIndex) of mining, -1 if never. */
  onset: Int16Array;
  /** Start of the current run of mining-looking observations, -1 if none. */
  runStart: Int16Array;
  /** Last month the pixel counted as mined, -1 if never. */
  lastMined: Int16Array;
  /** Months with any observation, for confidence. */
  observed: Uint16Array;
  /** First and last month processed (monthIndex), -1 before the first. */
  firstMonth: number;
  lastMonth: number;
}

export function newState(n: number, p: TrackerParams = DEFAULT_PARAMS): TrackerState {
  const s: TrackerState = {
    n,
    p0: new Float32Array(n).fill(1 - p.initialMined),
    p1: new Float32Array(n).fill(p.initialMined),
    p2: new Float32Array(n),
    onset: new Int16Array(n).fill(-1),
    runStart: new Int16Array(n).fill(-1),
    lastMined: new Int16Array(n).fill(-1),
    observed: new Uint16Array(n),
    firstMonth: -1,
    lastMonth: -1,
  };
  return s;
}

/**
 * Advance every pixel by one month. `prob` is the model's P(mining) per pixel (NaN where unobserved) and
 * `regime` how it was observed. Months must be processed in order; a skipped month is treated as unobserved.
 */
export function step(s: TrackerState, month: number, prob: Float32Array, regime: Uint8Array, p: TrackerParams = DEFAULT_PARAMS): void {
  if (s.lastMonth >= 0 && month <= s.lastMonth) throw new Error(`month ${monthName(month)} already processed (last ${monthName(s.lastMonth)})`);
  const gap = s.lastMonth >= 0 ? month - s.lastMonth : 1;
  if (s.firstMonth < 0) s.firstMonth = month;
  // Transition for `gap` months at once (unobserved months in between just move the chain forward).
  let a = p.onset, r = p.regrow, b = p.remine;
  if (gap > 1) {
    a = 1 - (1 - p.onset) ** gap;
    r = 1 - (1 - p.regrow) ** gap;
    b = 1 - (1 - p.remine) ** gap;
  }
  const priorOdds = p.modelPrior / (1 - p.modelPrior);
  for (let i = 0; i < s.n; i++) {
    const q0 = s.p0[i], q1 = s.p1[i], q2 = s.p2[i];
    let n0 = q0 * (1 - a);
    let n1 = q0 * a + q1 * (1 - r) + q2 * b;
    let n2 = q1 * r + q2 * (1 - b);
    const reg = regime[i] as Regime;
    const pr = prob[i];
    if (reg !== 0 && Number.isFinite(pr)) {
      const pc = Math.min(1 - p.clamp, Math.max(p.clamp, pr));
      const odds = pc / (1 - pc) / priorOdds; // evidence for mining against the model's prior
      n1 *= odds ** p.weight[reg as 1 | 2 | 3];
      s.observed[i] = Math.min(65535, s.observed[i] + 1);
      // Onset: the run of months whose evidence favours mining starts at the first such month; only an optical
      // month whose evidence favours no mining ends it. Radar-only months see through cloud but see less, so
      // they never end a run (on validation blocks this dates 93% of mines that predate the record at its start,
      // against 30% when any month below a calibrated 0.5 ended the run, at the same weights).
      if (odds >= 1) {
        if (s.runStart[i] < 0) s.runStart[i] = month;
      } else if (s.onset[i] < 0 && (reg === REGIME.sentinel2 || reg === REGIME.landsat)) {
        s.runStart[i] = -1;
      }
    }
    const z = n0 + n1 + n2;
    n0 /= z;
    n1 /= z;
    n2 /= z;
    s.p0[i] = n0;
    s.p1[i] = n1;
    s.p2[i] = n2;
    if (n1 >= p.threshold) {
      if (s.onset[i] < 0) s.onset[i] = s.runStart[i] >= 0 ? s.runStart[i] : month;
      s.lastMined[i] = month;
    }
  }
  s.lastMonth = month;
}

/** Current status of each pixel: 0 not mined, 1 mined now, 2 mined before but not now (regrown or quiet). */
export function status(s: TrackerState, p: TrackerParams = DEFAULT_PARAMS): Uint8Array {
  const out = new Uint8Array(s.n);
  for (let i = 0; i < s.n; i++) {
    if (s.p1[i] >= p.threshold) out[i] = 1;
    else if (s.onset[i] >= 0) out[i] = 2;
  }
  return out;
}

// --- Persistence ----------------------------------------------------------------------------------

const MAGIC = 0x47575453; // "GWTS"

/** Serialise a state (little-endian, versioned) so each live month continues from the last. */
export function encodeState(s: TrackerState): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(s.n, 8);
  head.writeInt32LE(s.firstMonth, 12);
  head.writeInt32LE(s.lastMonth, 16);
  const parts = [s.p0, s.p1, s.p2, s.onset, s.runStart, s.lastMined, s.observed].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  return Buffer.concat([head, ...parts]);
}

export function decodeState(buf: Buffer): TrackerState {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error("not a GhanaWatch tracker state");
  if (buf.readUInt32LE(4) !== 1) throw new Error(`unknown tracker state version ${buf.readUInt32LE(4)}`);
  const n = buf.readUInt32LE(8);
  let o = 24;
  const take = <T>(C: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number }) => {
    const bytes = n * C.BYTES_PER_ELEMENT;
    const copy = new ArrayBuffer(bytes);
    new Uint8Array(copy).set(buf.subarray(o, o + bytes));
    o += bytes;
    return new C(copy);
  };
  return {
    n,
    firstMonth: buf.readInt32LE(12),
    lastMonth: buf.readInt32LE(16),
    p0: take(Float32Array),
    p1: take(Float32Array),
    p2: take(Float32Array),
    onset: take(Int16Array),
    runStart: take(Int16Array),
    lastMined: take(Int16Array),
    observed: take(Uint16Array),
  };
}
