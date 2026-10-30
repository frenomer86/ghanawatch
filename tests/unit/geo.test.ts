import { describe, expect, it } from "vitest";
import type { Polygon } from "geojson";
import { areaHectares, bboxOf, centroidOf, haversineKm, pointInPolygon, squareAround, validateGeometry } from "@/lib/geo";

const square: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-1.0, 7.0],
      [-0.9, 7.0],
      [-0.9, 7.1],
      [-1.0, 7.1],
      [-1.0, 7.0],
    ],
  ],
};

describe("geometry helpers", () => {
  it("computes bbox and centroid", () => {
    expect(bboxOf(square)).toEqual([-1, 7, -0.9, 7.1]);
    const c = centroidOf(square);
    expect(c.lon).toBeCloseTo(-0.95, 6);
    expect(c.lat).toBeCloseTo(7.05, 6);
  });
  it("point in polygon", () => {
    expect(pointInPolygon([-0.95, 7.05], square)).toBe(true);
    expect(pointInPolygon([-0.5, 7.05], square)).toBe(false);
  });
  it("area of a 0.1° square near 7°N is about 12 200 ha", () => {
    const ha = areaHectares(square);
    expect(ha).toBeGreaterThan(11_500);
    expect(ha).toBeLessThan(12_800);
  });
  it("squareAround has the requested side", () => {
    const s = squareAround({ lon: -1.6, lat: 6.7 }, 375);
    expect(areaHectares(s)).toBeCloseTo(14.06, 0);
  });
  it("haversine Accra to Kumasi ≈ 200 km", () => {
    const d = haversineKm({ lon: -0.187, lat: 5.603 }, { lon: -1.624, lat: 6.688 });
    expect(d).toBeGreaterThan(195);
    expect(d).toBeLessThan(205);
  });
});

describe("validateGeometry", () => {
  it("accepts a closed polygon inside the box", () => {
    expect(validateGeometry(square, { within: [-3.4, 4.6, 1.3, 11.3] })).toEqual({ ok: true });
  });
  it("rejects unclosed, out of range, NaN and huge geometries", () => {
    const open: Polygon = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    expect(validateGeometry(open).ok).toBe(false);
    expect(validateGeometry({ type: "Point", coordinates: [200, 0] }).ok).toBe(false);
    expect(validateGeometry({ type: "Point", coordinates: [Number.NaN, 0] }).ok).toBe(false);
    expect(validateGeometry(square, { within: [0, 0, 1, 1] }).ok).toBe(false);
    const ring = Array.from({ length: 20_001 }, (_, i) => [Math.cos(i) * 0.01, Math.sin(i) * 0.01]);
    ring.push(ring[0]);
    expect(validateGeometry({ type: "Polygon", coordinates: [ring] }).ok).toBe(false);
  });
});
