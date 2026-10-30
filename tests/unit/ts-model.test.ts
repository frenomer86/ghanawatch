import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { N_CH } from "@/pipeline/ts/features";

/**
 * The exported model, run through the pipeline's own code (normalise, zero padding, tiling, ONNX Runtime), must
 * reproduce the trained network in PyTorch on a held-out GhanaWatch composite (fixture from
 * research/smallmines/model_parity.py). Skipped on a machine without the model files or the optional
 * onnxruntime-node (a laptop installed with --omit=optional).
 */
const dir = join(process.cwd(), "models");
const haveModel = existsSync(join(dir, "gw_mining_unet.onnx")) && existsSync(join(dir, "gw_mining_unet.json"));
let haveOrt = false;
try {
  require.resolve("onnxruntime-node");
  haveOrt = true;
} catch {
  haveOrt = false;
}

function f16(bits: number): number {
  const s = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const m = bits & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? Number.NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

describe.skipIf(!haveModel || !haveOrt)("mining model through the pipeline", () => {
  it("matches the trained network on a held-out composite", async () => {
    const { loadModel } = await import("@/pipeline/ts/model");
    const fx = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/model-parity.json"), "utf8")) as { w: number; h: number; rawF16: string; probF32: string };
    const n = fx.w * fx.h;
    const raw = Buffer.from(fx.rawF16, "base64");
    const ch = Array.from({ length: N_CH }, (_, k) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = f16(raw.readUInt16LE((k * n + i) * 2));
      return a;
    });
    const refBuf = Buffer.from(fx.probF32, "base64");
    const ref = new Float32Array(refBuf.buffer, refBuf.byteOffset, n);
    const model = await loadModel(dir);
    const p = await model.predict(ch, fx.w, fx.h);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(p[i] - ref[i]));
    expect(worst).toBeLessThan(1e-3);
    expect(model.meta.calibration?.sentinel2).toBeDefined();
    expect(model.meta.baseRate).toBeGreaterThan(0);
  }, 60_000);
});
