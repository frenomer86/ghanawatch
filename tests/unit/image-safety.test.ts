import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeYunet, iou, nms, yunetInput, type FaceBox } from "@/lib/server/reports/image-safety";

/**
 * The face detector behind photo blurring. The decoder must give the same boxes as OpenCV's own
 * cv::FaceDetectorYN on the same image: tests/fixtures/faces/cartoon.json was written by
 * research/reports/yunet_reference.py from the committed test picture (five drawn faces that YuNet scores
 * between 0.56 and 0.89). Running the model needs onnxruntime-node, an optional dependency.
 */
const require = createRequire(import.meta.url);
let haveOrt = true;
try {
  require.resolve("onnxruntime-node");
} catch {
  haveOrt = false;
}

describe("face box helpers", () => {
  it("suppresses the weaker of two overlapping boxes and keeps separate ones", () => {
    const a: FaceBox = { x: 0, y: 0, w: 10, h: 10, score: 0.9 };
    const b: FaceBox = { x: 2, y: 2, w: 10, h: 10, score: 0.8 };
    const c: FaceBox = { x: 50, y: 50, w: 10, h: 10, score: 0.7 };
    expect(iou(a, b)).toBeCloseTo(64 / 136, 6);
    expect(nms([c, b, a], 0.3)).toEqual([a, c]);
  });

  it("decodes one synthetic anchor the way OpenCV does", () => {
    const n8 = 80 * 80, n16 = 40 * 40, n32 = 20 * 20;
    const out: Record<string, Float32Array> = {
      cls_8: new Float32Array(n8), obj_8: new Float32Array(n8), bbox_8: new Float32Array(n8 * 4),
      cls_16: new Float32Array(n16), obj_16: new Float32Array(n16), bbox_16: new Float32Array(n16 * 4),
      cls_32: new Float32Array(n32), obj_32: new Float32Array(n32), bbox_32: new Float32Array(n32 * 4),
    };
    const i = 3 * 40 + 5; // stride 16, row 3, column 5
    out.cls_16[i] = 0.81;
    out.obj_16[i] = 1.2; // clamped to 1
    out.bbox_16.set([0.5, 0.25, Math.log(2), Math.log(3)], i * 4);
    const [f] = decodeYunet(out, 640, 0.6);
    expect(f.score).toBeCloseTo(0.9, 6);
    expect(f.x).toBeCloseTo((5 + 0.5) * 16 - 16, 4);
    expect(f.y).toBeCloseTo((3 + 0.25) * 16 - 24, 4);
    expect([f.w, f.h].map((v) => Math.round(v))).toEqual([32, 48]);
  });

  it("feeds the model blue-green-red planes in 0-255, the picture top-left and the rest black", () => {
    const x = yunetInput(Uint8Array.from([10, 20, 30, 40, 50, 60]), 2, 1, 4);
    expect(Array.from(x.subarray(0, 4))).toEqual([30, 60, 0, 0]);
    expect(Array.from(x.subarray(16, 20))).toEqual([20, 50, 0, 0]);
    expect(Array.from(x.subarray(32, 36))).toEqual([10, 40, 0, 0]);
  });
});

describe.skipIf(!haveOrt)("face detector against OpenCV", () => {
  it("finds the same faces, boxes and scores as cv2.FaceDetectorYN on the test picture", async () => {
    const sharp = (await import("sharp")).default;
    const { detectFacesRaw } = await import("@/lib/server/reports/image-safety");
    const ref = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/faces/cartoon.json"), "utf8")) as { scoreThreshold: number; faces: FaceBox[] };
    const { data, info } = await sharp(join(process.cwd(), "tests/fixtures/faces/cartoon.png")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const got = await detectFacesRaw(new Uint8Array(data), info.width, info.height, ref.scoreThreshold);
    expect(got).toHaveLength(ref.faces.length);
    got.forEach((g, k) => {
      const r = ref.faces[k];
      for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(g[key] - r[key])).toBeLessThan(0.05);
      expect(Math.abs(g.score - r.score)).toBeLessThan(1e-4);
    });
  });

  it("blurs every face it finds in the stored photo and leaves the rest of the picture alone", async () => {
    const sharp = (await import("sharp")).default;
    const { detectFaces, blurFaces } = await import("@/lib/server/reports/image-safety");
    const png = readFileSync(join(process.cwd(), "tests/fixtures/faces/cartoon.png"));
    const { faces, width, height } = await detectFaces(png, 0.5);
    expect(faces.length).toBeGreaterThanOrEqual(3);
    const out = await blurFaces(png, faces, width, height);
    const after = await detectFaces(out, 0.5);
    expect(after.faces.length).toBeLessThan(faces.length);
    // A corner far from every face is unchanged apart from WebP compression.
    const corner = async (img: Buffer) => (await sharp(img).extract({ left: 300, top: 250, width: 40, height: 40 }).raw().toBuffer()).reduce((s, v) => s + v, 0) / 4800;
    expect(Math.abs((await corner(out)) - (await corner(png)))).toBeLessThan(3);
  });
});
