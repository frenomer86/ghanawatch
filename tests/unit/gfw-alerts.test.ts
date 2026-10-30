import { describe, expect, it } from "vitest";
import { patchesInTile } from "@/pipeline/adapters/gfw-alerts";

describe("Global Forest Watch alert patches", () => {
  it("groups touching alert pixels and keeps dates and confidence", () => {
    const g = new Int32Array(256 * 256);
    const day = 4300; // days since 2014-12-31
    for (const [c, r] of [[10, 10], [11, 10], [11, 11], [12, 12]]) g[r * 256 + c] = day * 4 + 2; // high confidence
    g[10 * 256 + 13] = (day + 5) * 4 + 2; // touches (12,12)? no: separate unless diagonal
    g[200 * 256 + 200] = (day - 3) * 4 + 1; // a lone low-confidence pixel elsewhere
    const patches = patchesInTile(g, 8104, 7856);
    expect(patches).toHaveLength(3);
    const big = patches.find((p) => p.pixels === 4)!;
    expect(big.high).toBe(4);
    expect(big.first).toBe(big.last);
    const lone = patches.find((p) => p.high === 0)!;
    expect(lone.pixels).toBe(1);
    expect(big.lon).toBeCloseTo(-1.93, 1);
    expect(big.lat).toBeGreaterThan(5);
  });
});
