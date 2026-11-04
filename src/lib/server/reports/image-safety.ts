import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The photo screen every citizen report passes before it can be published without a moderator: a classifier
 * that scores how likely the picture is to be sexual content, and a face detector whose boxes are pixelated and
 * blurred out of the stored photo, so a bystander caught in a picture of a pit or a burning dump is never
 * identifiable on a public page.
 *
 *  Faces   YuNet (Wu et al., 2023; OpenCV Zoo, MIT licence), 232 kB, committed under models/. The image, or
 *          each tile of a large one, is letterboxed to 640 x 640 and the twelve output heads are decoded exactly
 *          as OpenCV's cv::FaceDetectorYN does (tests/unit/image-safety.test.ts holds the two to a fixture made
 *          by research/reports/yunet_reference.py). The threshold is lower than OpenCV's default (0.6 against
 *          0.9): a false box costs a blurred patch of mud, a missed face costs a person's privacy.
 *  Safety  A ViT-base classifier fine-tuned for sfw/nsfw (AdamCodd/vit-base-nsfw-detector, Apache-2.0, 8-bit
 *          ONNX, 88.5 MB). Too large for the repository, it is fetched once from a pinned revision on first use,
 *          checked against its SHA-256 and cached under DATA_DIR/models.
 *
 * Both run on ONNX Runtime, the optional dependency the detector already uses, in the report reviewer process
 * (src/pipeline/review-reports.ts), never in the web server.
 */

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

export const FACE_MODEL = {
  file: "face_detection_yunet_2023mar.onnx",
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  size: 640,
};

export const SAFETY_MODEL = {
  file: "nsfw_vit_base_q8.onnx",
  url: "https://huggingface.co/AdamCodd/vit-base-nsfw-detector/resolve/8587de998f441aac03fdd57a85d2e4cb808c7d64/onnx/model_quantized.onnx",
  sha256: "432763a6899ebc418c55f784b98f90565e5fc694c778d2ffcb0294b12f6a7404",
  bytes: 88_500_985,
  size: 384,
};

/** Face score at which a box is blurred. */
export const FACE_SCORE = 0.6;
/** Overlap above which the weaker of two face boxes is dropped (OpenCV's default). */
export const FACE_NMS = 0.3;

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface PhotoScreen {
  /** P(sexual content), or null when the classifier could not be loaded. */
  nsfw: number | null;
  faces: FaceBox[];
  /** The stored photo with every face blurred, when there was at least one; null otherwise. */
  blurred: Buffer | null;
  width: number;
  height: number;
}

const MODEL_DIR = process.env.GW_MODEL_DIR ?? path.join(process.cwd(), "models");
const cacheDir = () => path.resolve(process.cwd(), process.env.DATA_DIR ?? ".data", "models");

let ortP: Promise<Ort> | null = null;
const loadOrt = () =>
  (ortP ??= import("onnxruntime-node").catch(() => {
    ortP = null;
    throw new Error("onnxruntime-node is not installed; the photo screen needs it");
  }));

let faceP: Promise<Session> | null = null;
export function faceSession(dir = MODEL_DIR): Promise<Session> {
  return (faceP ??= (async () => {
    const file = path.join(dir, FACE_MODEL.file);
    const bytes = readFileSync(file);
    const sum = createHash("sha256").update(bytes).digest("hex");
    if (sum !== FACE_MODEL.sha256) throw new Error(`${FACE_MODEL.file}: checksum ${sum} does not match`);
    const ort = await loadOrt();
    return ort.InferenceSession.create(bytes, { graphOptimizationLevel: "all", intraOpNumThreads: 1 });
  })().catch((e) => {
    faceP = null;
    throw e;
  }));
}

let safetyP: Promise<Session> | null = null;
let safetyFailedAt = 0;
/** The safety classifier, downloaded on first use. A failed download is retried no sooner than an hour later. */
export function safetySession(): Promise<Session> {
  if (!safetyP && Date.now() - safetyFailedAt < 3_600_000) return Promise.reject(new Error("safety model download failed recently"));
  return (safetyP ??= (async () => {
    const file = await ensureDownloaded(SAFETY_MODEL);
    const ort = await loadOrt();
    return ort.InferenceSession.create(file, { graphOptimizationLevel: "all", intraOpNumThreads: 2 });
  })().catch((e) => {
    safetyP = null;
    safetyFailedAt = Date.now();
    throw e;
  }));
}

/** Download `spec.url` once into the model cache, verifying size and SHA-256 before it is used. */
async function ensureDownloaded(spec: { file: string; url: string; sha256: string; bytes: number }): Promise<string> {
  const dir = cacheDir();
  const file = path.join(dir, spec.file);
  const marker = `${file}.sha256`;
  if (existsSync(file) && existsSync(marker) && readFileSync(marker, "utf8").trim() === spec.sha256) {
    const st = await fs.stat(file);
    if (st.size === spec.bytes) return file;
  }
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.part`;
  const res = await fetch(spec.url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`${spec.file}: download failed (${res.status})`);
  const hash = createHash("sha256");
  let n = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (c: Buffer) => {
    hash.update(c);
    n += c.length;
  });
  await pipeline(body, createWriteStream(tmp));
  const sum = hash.digest("hex");
  if (n !== spec.bytes || sum !== spec.sha256) {
    await fs.rm(tmp, { force: true });
    throw new Error(`${spec.file}: downloaded ${n} bytes with checksum ${sum}; expected ${spec.bytes} bytes, ${spec.sha256}`);
  }
  await fs.rename(tmp, file);
  await fs.writeFile(marker, spec.sha256);
  return file;
}

// ---------------------------------------------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * YuNet's outputs to face boxes in the 640 x 640 input, as cv::FaceDetectorYN::detect decodes them: per stride
 * s in (8, 16, 32) and grid cell (r, c), score = sqrt(cls * obj) (each clamped to [0, 1]), centre = ((c, r) +
 * offset) * s, size = exp(log-size) * s; then greedy non-maximum suppression.
 */
export function decodeYunet(out: Record<string, ArrayLike<number>>, size = FACE_MODEL.size, scoreThr = FACE_SCORE, nmsThr = FACE_NMS): FaceBox[] {
  const cand: FaceBox[] = [];
  for (const s of [8, 16, 32]) {
    const cols = Math.floor(size / s);
    const rows = Math.floor(size / s);
    const cls = out[`cls_${s}`];
    const obj = out[`obj_${s}`];
    const bb = out[`bbox_${s}`];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (!(score >= scoreThr)) continue;
        const cx = (c + bb[i * 4]) * s;
        const cy = (r + bb[i * 4 + 1]) * s;
        const w = Math.exp(bb[i * 4 + 2]) * s;
        const h = Math.exp(bb[i * 4 + 3]) * s;
        cand.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
      }
    }
  }
  return nms(cand, nmsThr);
}

export function iou(a: FaceBox, b: FaceBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function nms(boxes: FaceBox[], thr: number): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: FaceBox[] = [];
  for (const b of sorted) if (keep.every((k) => iou(k, b) <= thr)) keep.push(b);
  return keep;
}

/** RGB (interleaved, 3 bytes per pixel) of a w x h image, placed top-left in a 640 x 640 BGR planar float tensor. */
export function yunetInput(rgb: Uint8Array, w: number, h: number, size = FACE_MODEL.size): Float32Array {
  const x = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const s = (r * w + c) * 3;
      const d = r * size + c;
      x[d] = rgb[s + 2];
      x[plane + d] = rgb[s + 1];
      x[2 * plane + d] = rgb[s];
    }
  }
  return x;
}

/** Faces in a 640 x 640 (or smaller, top-left aligned) RGB raster. */
export async function detectFacesRaw(rgb: Uint8Array, w: number, h: number, scoreThr = FACE_SCORE): Promise<FaceBox[]> {
  const [ort, session] = await Promise.all([loadOrt(), faceSession()]);
  const size = FACE_MODEL.size;
  const res = await session.run({ input: new ort.Tensor("float32", yunetInput(rgb, w, h, size), [1, 3, size, size]) });
  const out: Record<string, ArrayLike<number>> = {};
  for (const [k, v] of Object.entries(res)) out[k] = v.data as Float32Array;
  return decodeYunet(out, size, scoreThr);
}

/**
 * Faces anywhere in a photo, in its own pixel coordinates. The whole picture is searched at 640 px, and a large
 * one also in overlapping tiles of about 900 px, so that a face 30 px wide in a 2048 px photo (10 px at 640,
 * below what YuNet finds) is searched for at a scale it can see.
 */
export async function detectFaces(image: Buffer, scoreThr = FACE_SCORE): Promise<{ faces: FaceBox[]; width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return { faces: [], width: W, height: H };
  const size = FACE_MODEL.size;
  const views: Array<{ left: number; top: number; width: number; height: number }> = [{ left: 0, top: 0, width: W, height: H }];
  const tile = 900;
  if (Math.max(W, H) > tile * 1.25) {
    const starts = (n: number) => {
      if (n <= tile) return [0];
      const k = Math.ceil((n - tile) / (tile * 0.75)) + 1;
      return Array.from({ length: k }, (_, i) => Math.round((i * (n - tile)) / (k - 1)));
    };
    for (const top of starts(H)) for (const left of starts(W)) views.push({ left, top, width: Math.min(tile, W - left), height: Math.min(tile, H - top) });
  }
  const all: FaceBox[] = [];
  for (const v of views) {
    const scale = size / Math.max(v.width, v.height);
    const w = Math.max(1, Math.round(v.width * scale));
    const h = Math.max(1, Math.round(v.height * scale));
    const { data } = await sharp(image)
      .extract(v)
      .removeAlpha()
      .resize(w, h, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (const f of await detectFacesRaw(new Uint8Array(data.buffer, data.byteOffset, data.length), w, h, scoreThr)) {
      all.push({ x: v.left + f.x / scale, y: v.top + f.y / scale, w: f.w / scale, h: f.h / scale, score: f.score });
    }
  }
  // The same face found in the whole picture and in a tile: keep one box (all are blurred either way).
  return { faces: nms(all, FACE_NMS), width: W, height: H };
}

/**
 * Pixelate and blur each face box, widened by a quarter on each side to take in hair and ears, and re-encode
 * the photo as WebP. Each face is reduced to blocks of about a sixteenth of its width and then smoothed, which
 * leaves nothing to sharpen back.
 */
export async function blurFaces(image: Buffer, faces: FaceBox[], width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const overlays = [];
  for (const f of faces) {
    const left = Math.max(0, Math.floor(f.x - f.w * 0.25));
    const top = Math.max(0, Math.floor(f.y - f.h * 0.3));
    const right = Math.min(width, Math.ceil(f.x + f.w * 1.25));
    const bottom = Math.min(height, Math.ceil(f.y + f.h * 1.2));
    const w = right - left;
    const h = bottom - top;
    if (w < 2 || h < 2) continue;
    const tiny = await sharp(image)
      .extract({ left, top, width: w, height: h })
      .resize(Math.max(1, Math.round(w / 16)), Math.max(1, Math.round(h / 16)), { fit: "fill" })
      .png()
      .toBuffer();
    const block = await sharp(tiny)
      .resize(w, h, { fit: "fill", kernel: "nearest" })
      .blur(Math.max(1, Math.min(w, h) / 10))
      .png()
      .toBuffer();
    overlays.push({ input: block, left, top });
  }
  return sharp(image).composite(overlays).webp({ quality: 82 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------------------------
// Sexual content
// ---------------------------------------------------------------------------------------------------------------

/** P(nsfw) from the ViT classifier: 384 x 384, scaled to [-1, 1] (mean and std 0.5), softmax over (sfw, nsfw). */
export async function nsfwScore(image: Buffer): Promise<number> {
  const [ort, session, sharp] = await Promise.all([loadOrt(), safetySession(), import("sharp").then((m) => m.default)]);
  const n = SAFETY_MODEL.size;
  const { data } = await sharp(image).removeAlpha().resize(n, n, { fit: "fill", kernel: "linear" }).raw().toBuffer({ resolveWithObject: true });
  const x = new Float32Array(3 * n * n);
  const plane = n * n;
  for (let i = 0; i < plane; i++) {
    x[i] = data[i * 3] / 127.5 - 1;
    x[plane + i] = data[i * 3 + 1] / 127.5 - 1;
    x[2 * plane + i] = data[i * 3 + 2] / 127.5 - 1;
  }
  const out = await session.run({ pixel_values: new ort.Tensor("float32", x, [1, 3, n, n]) });
  const [sfw, nsfw] = out.logits.data as Float32Array;
  return 1 / (1 + Math.exp(sfw - nsfw));
}

/**
 * Screen one stored photo: the safety score (null if the classifier is unavailable, which holds the report for
 * a later pass) and the faces, with a blurred copy of the photo when there are any.
 */
export async function screenPhoto(image: Buffer): Promise<PhotoScreen> {
  let nsfw: number | null = null;
  try {
    nsfw = await nsfwScore(image);
  } catch (e) {
    console.error("[reports] safety classifier unavailable:", e instanceof Error ? e.message : e);
  }
  const { faces, width, height } = await detectFaces(image);
  const blurred = faces.length ? await blurFaces(image, faces, width, height) : null;
  return { nsfw, faces, blurred, width, height };
}
