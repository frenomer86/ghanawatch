import { describe, expect, it } from "vitest";
import { coastLevel, coastTotals, isSignificant, strongestStretches, type CoastPoint } from "@/lib/domain/coast";
import { readHotspot } from "@/pipeline/adapters/coastlines";

/** Coastline change from Digital Earth Africa Coastlines: reading a hotspot, significance and the strongest stretches. */
const pt = (lon: number, rateMYr: number, over: Partial<CoastPoint> = {}): CoastPoint => ({ lon, lat: 5.77, rateMYr, sig: 0.001, certainty: "good", changeM: rateMYr * 25, latestYear: 2025, place: null, districtId: null, ...over });

describe("coastline", () => {
  it("reads rate, significance and the movement from 2000 to the latest year", () => {
    const p = readHotspot({
      geometry: { type: "Point", coordinates: [0.7005117, 5.7739121] },
      properties: { rate_time: -10.904, sig_time: 0, se_time: 0.4, certainty: "good", dist_2000: 120.5, dist_2001: 110, dist_2024: -150, dist_2025: -166.8, dist_2026: null },
    })!;
    expect(p).toMatchObject({ lon: 0.70051, lat: 5.77391, rateMYr: -10.904, sig: 0, certainty: "good", latestYear: 2025, changeM: -287.3 });
    expect(readHotspot({ geometry: null, properties: {} })).toBeNull();
    expect(readHotspot({ geometry: { type: "Point", coordinates: [0, 5] }, properties: { rate_time: null } })).toBeNull();
  });

  it("counts a trend only when significant, rated good and at least half a metre a year", () => {
    expect(isSignificant(pt(0, -3))).toBe(true);
    expect(isSignificant(pt(0, -3, { sig: 0.05 }))).toBe(false);
    expect(isSignificant(pt(0, -3, { certainty: "insufficient observations" }))).toBe(false);
    expect(isSignificant(pt(0, -0.3))).toBe(false);
    expect([-6, -3, -1, 0, 1].map(coastLevel)).toEqual(["severe", "high", "moderate", "low", "growing"]);
  });

  it("lists the strongest stretches at least 4 km apart and totals the coast", () => {
    // 0.01 degree of longitude here is about 1.1 km.
    const pts = [pt(0.7, -10.9), pt(0.705, -8.7), pt(0.71, -7.8), pt(0.76, -2.7), pt(1.05, -4), pt(0.3, 2.5), pt(0.4, -0.2)];
    expect(strongestStretches(pts, -1, 5).map((p) => p.rateMYr)).toEqual([-10.9, -4, -2.7]);
    expect(strongestStretches(pts, 1, 5).map((p) => p.rateMYr)).toEqual([2.5]);
    expect(coastTotals(pts)).toEqual({ measured: 7, retreating: 5, growing: 1, severe: 5 });
  });
});
