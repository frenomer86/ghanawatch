import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { N_CH, normalise, type Norm } from "./features";

/**
 * The mining-state model: a U-Net (ResNet-18 encoder) that maps one month's 24 input channels to the
 * probability that each pixel is part of a mining footprint. Trained on SmallMinesDS (Ofori-Ampofo et
 * al., 2025) with GhanaWatch's own composites; see research/smallmines/ and docs/detector.md.
 *
 * It runs through ONNX Runtime, an optional dependency installed in the pipeline image
 * (`npm install` on a laptop can skip it with --omit=optional; the web site never loads it).
 * Large grids are cut into overlapping 128-pixel tiles whose predictions are blended with a tent weight,
 * so tile edges leave no seams.
 */
export interface ModelMeta {
  model: string;
  version: string;
  channels: string[];
  mean: number[];
  std: number[];
  patch: number;
  stride: number;
  threshold: number;
  /** Per-regime logistic recalibration of the output: p' = sigmoid(a * logit(p) + b). */
  calibration?: Record<string, { a: number; b: number }>;
  /** Base rate of mining in the calibration data (the tracker's model prior). */
  baseRate?: number;
  trainedOn?: string;
  metrics?: Record<string, unknown>;
}

export const MODEL_DIR = process.env.GW_MODEL_DIR ?? join(process.cwd(), "models");

export interface MiningModel {
  meta: ModelMeta;
  /** P(mining) per pixel for raw (un-normalised) channels on a w x h grid. Channels are normalised in place. */
  predict(ch: Float32Array[], w: number, h: number): Promise<Float32Array>;
}

type Ort = typeof import("onnxruntime-node");

export async function loadModel(dir = MODEL_DIR): Promise<MiningModel> {
  const metaPath = join(dir, "gw_mining_unet.json");
  const onnxPath = join(dir, "gw_mining_unet.onnx");
  if (!existsSync(metaPath) || !existsSync(onnxPath)) throw new Error(`mining model not found in ${dir} (gw_mining_unet.onnx and .json)`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ModelMeta;
  if (meta.channels.length !== N_CH) throw new Error(`model expects ${meta.channels.length} channels, GhanaWatch builds ${N_CH}`);
  let ort: Ort;
  try {
    ort = await import("onnxruntime-node");
  } catch {
    throw new Error("onnxruntime-node is not installed (run `npm install` without --omit=optional on the machine that runs the detector)");
  }
  // onnxruntime-node rejects an explicit undefined thread count, so the option is set only when given.
  const threads = Number(process.env.GW_MODEL_THREADS ?? 0);
  const session = await ort.InferenceSession.create(onnxPath, { graphOptimizationLevel: "all", ...(threads > 0 ? { intraOpNumThreads: threads } : {}) });
  const norm: Norm = { mean: meta.mean, std: meta.std };
  return {
    meta,
    async predict(ch, w, h) {
      normalise(ch, norm);
      return tiledPredict(ch, w, h, meta.patch, meta.stride, async (batch, n, ph, pw) => {
        const out = await session.run({ x: new ort.Tensor("float32", batch, [n, N_CH, ph, pw]) });
        return out.p.data as Float32Array;
      });
    },
  };
}

/** Tile positions along one axis: start at 0, step by `stride`, last tile flush with the edge. */
export function tileStarts(size: number, patch: number, stride: number): number[] {
  if (size <= patch) return [0];
  const out: number[] = [];
  for (let s = 0; s + patch < size; s += stride) out.push(s);
  out.push(size - patch);
  return [...new Set(out)];
}

/**
 * Run `infer` over overlapping tiles and blend. Grids smaller than a tile are padded with zeros (the
 * normalised mean) and cropped back. Exported for tests with a fake model.
 */
export async function tiledPredict(
  ch: Float32Array[],
  w: number,
  h: number,
  patch: number,
  stride: number,
  infer: (batch: Float32Array, n: number, ph: number, pw: number) => Promise<Float32Array>,
  batchSize = 8,
): Promise<Float32Array> {
  const P = patch;
  const acc = new Float32Array(w * h);
  const wsum = new Float32Array(w * h);
  // Tent weight: 1 in the middle, small at the tile edge, so overlapping tiles hand over smoothly.
  const tent = new Float32Array(P * P);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) tent[y * P + x] = (1 - Math.abs((y + 0.5) / P - 0.5)) * (1 - Math.abs((x + 0.5) / P - 0.5));
  const tiles: Array<[number, number]> = [];
  for (const y0 of tileStarts(h, P, stride)) for (const x0 of tileStarts(w, P, stride)) tiles.push([y0, x0]);
  for (let t = 0; t < tiles.length; t += batchSize) {
    const part = tiles.slice(t, t + batchSize);
    const batch = new Float32Array(part.length * N_CH * P * P);
    part.forEach(([y0, x0], b) => {
      for (let k = 0; k < N_CH; k++) {
        const src = ch[k];
        const base = (b * N_CH + k) * P * P;
        for (let y = 0; y < P; y++) {
          const yy = y0 + y;
          if (yy >= h) break;
          const n = Math.min(P, w - x0);
          batch.set(src.subarray(yy * w + x0, yy * w + x0 + n), base + y * P);
        }
      }
    });
    const prob = await infer(batch, part.length, P, P);
    part.forEach(([y0, x0], b) => {
      for (let y = 0; y < P; y++) {
        const yy = y0 + y;
        if (yy >= h) break;
        for (let x = 0; x < P; x++) {
          const xx = x0 + x;
          if (xx >= w) break;
          const wt = tent[y * P + x];
          acc[yy * w + xx] += prob[b * P * P + y * P + x] * wt;
          wsum[yy * w + xx] += wt;
        }
      }
    });
  }
  for (let i = 0; i < acc.length; i++) acc[i] = wsum[i] > 0 ? acc[i] / wsum[i] : Number.NaN;
  return acc;
}

/** Recalibrate a raw model probability for the regime it was observed in. */
export function calibrate(p: number, regime: string, meta: ModelMeta): number {
  const c = meta.calibration?.[regime];
  if (!c || !Number.isFinite(p)) return p;
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  const z = c.a * Math.log(q / (1 - q)) + c.b;
  return 1 / (1 + Math.exp(-z));
}
