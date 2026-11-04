import { describe, expect, it } from "vitest";
import { rasterise, simplifyPolygon, simplifyRing } from "@/pipeline/reservoirs/geometry";
import { measure, passesOf } from "@/pipeline/adapters/reservoirs";
import { smoothed, summarise, waterThreshold, WATER_DB } from "@/lib/domain/reservoirs";
import type { RadarScene } from "@/pipeline/s1/pc";

/** The reservoir monitor: outline simplification and filling, the water threshold, and the summaries. */
describe("outlines", () => {
  it("drops vertices closer to the line than the tolerance and keeps the corners", () => {
    const ring = [[0, 0], [5, 0.01], [10, 0], [10, 10], [5, 10.02], [0, 10], [0, 0]];
    expect(simplifyRing(ring, 0.05)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    expect(simplifyRing(ring, 0.001)).toHaveLength(7);
  });

  it("drops a polygon smaller than the tolerance and keeps holes", () => {
    const big = { type: "Polygon" as const, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
    const tiny = [[[20, 20], [20.001, 20], [20.001, 20.001], [20, 20]]];
    const out = simplifyPolygon({ type: "MultiPolygon", coordinates: [big.coordinates, tiny] }, 0.01);
    expect(out.coordinates).toHaveLength(1);
    expect(out.coordinates[0]).toHaveLength(2);
  });

  it("fills pixels whose centres are inside, leaving holes empty", () => {
    const m = rasterise([[[1, 1], [9, 1], [9, 9], [1, 9], [1, 1]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]], 10, 10);
    let n = 0;
    for (const v of m) n += v;
    expect(n).toBe(64 - 4);
    expect(m[0]).toBe(0);
    expect(m[1 * 10 + 1]).toBe(1);
    expect(m[4 * 10 + 4]).toBe(0);
  });
});

describe("water threshold and measurement", () => {
  it("splits open water from shore when both are there, and falls back when the lake is uniform", () => {
    const vals = [...Array.from({ length: 600 }, (_, i) => -25 + (i % 7) * 0.3), ...Array.from({ length: 400 }, (_, i) => -10 + (i % 9) * 0.4)];
    const t = waterThreshold(vals);
    expect(t).toBeGreaterThanOrEqual(WATER_DB.min);
    expect(t).toBeLessThanOrEqual(WATER_DB.max);
    // One bell-shaped mode (a sum of three even spreads): no second class to split off.
    const bell = Array.from({ length: 3000 }, (_, i) => -24 + ((i * 7919) % 101) / 100 + ((i * 104729) % 97) / 97 + ((i * 1299709) % 89) / 89);
    expect(waterThreshold(bell)).toBe(WATER_DB.fallback);
  });

  it("measures the wet share of the part of the outline the radar saw, and skips passes that saw too little", () => {
    const mask = Uint8Array.from([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    const vh = Float32Array.from([-26, -26, -26, -12, -12, -26, -26, -26, -26, -26]);
    const r = measure(vh, mask, 5, 0.01, 0.05)!;
    expect(r.waterPct).toBe(60);
    expect(r.observedPct).toBe(100);
    expect(r.waterKm2).toBeCloseTo(0.03, 6);
    const half = Float32Array.from([-26, NaN, NaN, NaN, -12, 0, 0, 0, 0, 0]);
    expect(measure(half, mask, 5, 0.01, 0.05)).toBeNull();
  });

  it("groups frames into passes by day, orbit direction and satellite", () => {
    const sc = (id: string, datetime: string, orbit: "ascending" | "descending", platform = "SENTINEL-1C"): RadarScene => ({ id, datetime, orbit, platform, epsg: 32630, vv: id, vh: id });
    const p = passesOf([sc("b", "2026-10-02T18:10:00Z", "ascending"), sc("a", "2026-10-02T18:09:30Z", "ascending"), sc("c", "2026-09-26T06:00:00Z", "descending"), sc("d", "2026-10-02T06:00:00Z", "descending", "SENTINEL-1A")]);
    expect(p.map((x) => [x.date, x.orbit, x.scenes.length])).toEqual([["2026-09-26", "descending", 1], ["2026-10-02", "ascending", 2], ["2026-10-02", "descending", 1]]);
  });
});

describe("summaries", () => {
  const o = (date: string, waterPct: number) => ({ date, waterPct, waterKm2: waterPct, observedPct: 100 });

  it("smooths single-pass dips with a running median of three, the last point over the last three", () => {
    expect(smoothed([o("2026-01-01", 90), o("2026-01-07", 55), o("2026-01-13", 91), o("2026-01-19", 92)]).map((x) => x.waterPct)).toEqual([90, 90, 91, 91]);
  });

  it("reports the change over a month and a year, and calls changes under 2 points steady", () => {
    const s = summarise([o("2025-10-05", 80), o("2026-09-05", 70), o("2026-09-11", 71), o("2026-10-05", 66), o("2026-10-11", 65), o("2026-10-17", 64)]);
    expect(s.latest?.date).toBe("2026-10-17");
    expect(s.latest?.waterPct).toBe(65);
    expect(s.changeMonth).toBe(-5);
    expect(s.trend).toBe("falling");
    expect(s.changeYear).toBe(-15);
    const y = summarise([o("2025-10-20", 80), o("2026-09-20", 70), o("2026-10-20", 71)]);
    expect(y.changeYear).toBe(-9);
    expect(y.trend).toBe("steady");
  });
});
