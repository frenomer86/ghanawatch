import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeOccurrence, type WaterSeen } from "@/pipeline/context/surface-water";
import { makeGrid } from "@/pipeline/s2/cog";
import { maskWaterSeen } from "@/pipeline/s2/process";

describe("long-term water record (JRC Global Surface Water)", () => {
  it("reads occurrence from the tile colours: blue is the share of past observations, transparent is never", async () => {
    const raw = Buffer.alloc(256 * 256 * 4);
    raw.set([0, 0, 255, 255], 0); // always water
    raw.set([230, 0, 25, 25], 4); // water in about 10% of observations
    raw.set([0, 0, 0, 0], 8); // never water
    const png = await sharp(raw, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
    const occ = await decodeOccurrence(png);
    expect([occ[0], occ[1], occ[2]]).toEqual([100, 10, 0]);
  });

  it("drops cleared and new-pond pixels where water was seen before, but keeps muddy-river pixels", async () => {
    const grid = makeGrid([600_000, 900_000, 600_060, 900_020], 20);
    const wet: WaterSeen = { occurrence: async () => 40 };
    const dry: WaterSeen = { occurrence: async () => 4 };
    const cls = Uint8Array.from([1, 2, 3]);
    expect(await maskWaterSeen(Uint8Array.from(cls), grid, 32630, dry)).toBe(0);
    const masked = Uint8Array.from(cls);
    expect(await maskWaterSeen(masked, grid, 32630, wet)).toBe(2);
    expect([...masked]).toEqual([0, 0, 3]);
  });
});
