import { describe, expect, it } from "vitest";
import { findTargets, riverWindows } from "@/pipeline/s1/river-watch";
import { newWaterMask } from "@/pipeline/s1/water";
import { mergeSameKey } from "@/pipeline/adapters/sentinel1";

const W = 30;
const H = 30;

/** A 30 x 30 window with a river five pixels wide down the middle. */
function river(waterDb = -20, bankDb = -9) {
  const vv = new Float32Array(W * H).fill(bankDb);
  const near = new Uint8Array(W * H);
  const zone = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x >= 12 && x <= 16) {
        vv[i] = waterDb;
        near[i] = 1;
      }
      if (x >= 8 && x <= 20) zone[i] = 1;
    }
  }
  return { vv, near, zone };
}

describe("radar river watch rules", () => {
  it("finds a small bright platform on open water", () => {
    const { vv, near, zone } = river();
    vv[15 * W + 14] = 8;
    vv[15 * W + 15] = 2;
    const r = findTargets(vv, W, H, near, zone);
    expect(r.skipped).toBeNull();
    expect(r.found).toHaveLength(1);
    expect(r.found[0]).toEqual({ i: 15 * W + 14, db: 8 });
  });

  it("ignores a large bright patch such as a building or a bank", () => {
    const { vv, near, zone } = river();
    for (let y = 10; y < 16; y++) for (let x = 12; x < 16; x++) vv[y * W + x] = 5;
    expect(findTargets(vv, W, H, near, zone).found).toHaveLength(0);
  });

  it("skips water roughened by wind or rain, and stretches with no visible water", () => {
    const rough = river(-6);
    rough.vv[15 * W + 14] = 8;
    expect(findTargets(rough.vv, W, H, rough.near, rough.zone).skipped).toBe("no-water");
    const choppy = river();
    for (let y = 0; y < H; y += 2) for (let x = 12; x <= 16; x++) choppy.vv[y * W + x] = -5;
    expect(findTargets(choppy.vv, W, H, choppy.near, choppy.zone).skipped).toBe("rough");
  });

  it("groups resampled river points into 3 km windows", () => {
    const windows = riverWindows([{ name: "Pra", coords: [[-1.6, 5.2], [-1.6, 5.26]] }], 32630);
    const total = [...windows.values()].reduce((s, w) => s + w.length, 0);
    expect(windows.size).toBeGreaterThanOrEqual(3);
    expect(total).toBeGreaterThan(300); // about 6.6 km every 20 m
    expect([...windows.values()][0][0].river).toBe("Pra");
  });
});

describe("radar new ponds", () => {
  it("marks land that turned to water, but not water that was already there or its edge", () => {
    const n = 20 * 20;
    const before = new Float32Array(n).fill(-8);
    const now = new Float32Array(n).fill(-8);
    for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) now[y * 20 + x] = -22; // new pond
    for (let y = 0; y < 20; y++) {
      before[y * 20 + 17] = -21; // an existing river
      now[y * 20 + 17] = -21;
      now[y * 20 + 15] = -21; // the river widening in the rains
    }
    const mask = newWaterMask(now, before, { width: 20, height: 20 });
    expect(mask[7 * 20 + 7]).toBe(1);
    expect(mask[7 * 20 + 15]).toBe(0);
    expect(mask[7 * 20 + 17]).toBe(0);
    expect(mask[2 * 20 + 2]).toBe(0);
  });
});

describe("radar pond detections", () => {
  const pond = (lon: number, lat: number, areaHa: number) => ({
    pixels: [1],
    areaHa,
    centre: { lon, lat },
    ring: [[lon, lat], [lon + 0.0004, lat], [lon + 0.0004, lat + 0.0004], [lon, lat]] as [number, number][],
  });

  it("merges ponds that share a location key so none overwrites another", () => {
    const merged = mergeSameKey([pond(-1.4601, 6.3812, 0.7), pond(-1.4604, 6.3814, 3.4), pond(-1.4779, 6.3831, 0.5)]);
    expect(merged).toHaveLength(2);
    expect(merged[0].areaHa).toBeCloseTo(4.1);
    expect(merged[0].centre).toEqual({ lon: -1.4604, lat: 6.3814 });
    expect(merged[0].ring[0]).toEqual(merged[0].ring[merged[0].ring.length - 1]);
  });
});
