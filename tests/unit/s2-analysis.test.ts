import { describe, expect, it } from "vitest";
import { classify, composite, type SceneBands } from "@/pipeline/s2/analysis";
import { makeGrid } from "@/pipeline/s2/cog";

/** One-pixel scenes; reflectances in DN with scale 0.0001. */
const VEG = { blue: 300, green: 600, red: 300, nir: 3500, swir16: 1500, scl: 4 };
const BARE = { blue: 800, green: 1000, red: 1500, nir: 2200, swir16: 3000, scl: 5 };
/** An unflagged cloud shadow over forest: dark in every band, so its ratios look like water. */
const SHADOW = { blue: 150, green: 200, red: 120, nir: 160, swir16: 300, scl: 4 };

function scene(date: string, tile: string, px: typeof VEG): SceneBands {
  const one = (v: number) => Uint16Array.from([v]);
  return { date, sceneId: `S2A_${tile}_${date.replaceAll("-", "")}_0_L2A`, blue: one(px.blue), green: one(px.green), red: one(px.red), nir: one(px.nir), swir16: one(px.swir16), scl: Uint8Array.from([px.scl]), scale: 0.0001, offset: 0 };
}

describe("Sentinel-2 change rules", () => {
  const grid = makeGrid([0, 0, 20, 20], 20);
  const before = composite([scene("2025-01-10", "30NXN", VEG), scene("2025-02-12", "30NXN", VEG)], 1);

  it("counts one satellite pass once where neighbouring tiles overlap", () => {
    const after = composite([scene("2026-09-01", "30NXN", BARE), scene("2026-09-01", "30NXM", BARE), scene("2026-09-15", "30NXN", VEG)], 1);
    expect(after.count[0]).toBe(2);
    expect(after.lostObs[0]).toBe(1);
    // One pass with bare-looking ground (or a cloud shadow) is not enough for a detection.
    expect(classify(before, after, grid, { turbidity: false })[0]).toBe(0);
  });

  it("reports cleared land seen bare on two different passes", () => {
    const after = composite([scene("2026-09-01", "30NXN", BARE), scene("2026-09-20", "30NXN", BARE)], 1);
    expect(after.lostObs[0]).toBe(2);
    expect(classify(before, after, grid, { turbidity: false })[0]).toBe(1);
  });

  it("does not read an unflagged cloud shadow as a new pond or bare ground", () => {
    const after = composite([scene("2026-09-01", "30NXN", SHADOW), scene("2026-09-20", "30NXN", SHADOW)], 1);
    expect(after.ndwi[0]).toBeGreaterThan(0.05);
    expect(after.waterObs[0]).toBe(0);
    expect(after.lostObs[0]).toBe(0);
    expect(classify(before, after, grid, { turbidity: false })[0]).toBe(0);
  });
});
