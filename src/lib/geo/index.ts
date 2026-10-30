import type { BBox } from "@/lib/domain/types";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";

/** Pure geometry helpers: bbox, centroid, point-in-polygon, distance. No I/O. */

export function bboxOf(geom: Geometry): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  walk(geom, ([x, y]) => {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  });
  return b;
}

export function bboxCenter(b: BBox): { lon: number; lat: number } {
  return { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Area-weighted centroid for polygons; mean of vertices otherwise. */
export function centroidOf(geom: Geometry): { lon: number; lat: number } {
  if (geom.type === "Polygon") return polygonCentroid(geom.coordinates);
  if (geom.type === "MultiPolygon") {
    let ax = 0,
      ay = 0,
      aw = 0;
    for (const poly of geom.coordinates) {
      const area = Math.abs(ringArea(poly[0]));
      const c = polygonCentroid(poly);
      ax += c.lon * area;
      ay += c.lat * area;
      aw += area;
    }
    return aw > 0 ? { lon: ax / aw, lat: ay / aw } : bboxCenter(bboxOf(geom));
  }
  if (geom.type === "Point") return { lon: geom.coordinates[0], lat: geom.coordinates[1] };
  return bboxCenter(bboxOf(geom));
}

function polygonCentroid(rings: Position[][]): { lon: number; lat: number } {
  const ring = rings[0];
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = bboxOf({ type: "Polygon", coordinates: rings });
    return bboxCenter(b);
  }
  a *= 0.5;
  return { lon: cx / (6 * a), lat: cy / (6 * a) };
}

function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

/** Approximate area in hectares for small polygons (equirectangular projection at the polygon's latitude). */
export function areaHectares(geom: Polygon | MultiPolygon): number {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let total = 0;
  for (const rings of polys) {
    const lat0 = (centroidOf({ type: "Polygon", coordinates: rings }).lat * Math.PI) / 180;
    const kx = 111_320 * Math.cos(lat0);
    const ky = 110_574;
    const outer = Math.abs(ringArea(rings[0].map(([x, y]) => [x * kx, y * ky])));
    const holes = rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r.map(([x, y]) => [x * kx, y * ky]))), 0);
    total += outer - holes;
  }
  return total / 10_000;
}

export function pointInRing(pt: Position, ring: Position[]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt: Position, geom: Polygon | MultiPolygon): boolean {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const rings of polys) {
    if (!pointInRing(pt, rings[0])) continue;
    if (rings.slice(1).some((hole) => pointInRing(pt, hole))) continue;
    return true;
  }
  return false;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const toRad = (d: number) => (d * Math.PI) / 180;

/** Bounding box of a circle around a point, for a cheap pre-filter before haversine. */
export function bboxAround(center: { lon: number; lat: number }, radiusKm: number): BBox {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos(toRad(center.lat)) || 1e-6);
  return [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat];
}

export function countVertices(geom: Geometry): number {
  let n = 0;
  walk(geom, () => n++);
  return n;
}

/** Reject geometries that are malformed, enormous, or outside a tolerance box. */
export function validateGeometry(
  geom: Geometry,
  opts: { maxVertices?: number; within?: BBox } = {},
): { ok: true } | { ok: false; reason: string } {
  const maxVertices = opts.maxVertices ?? 10_000;
  if (countVertices(geom) > maxVertices) return { ok: false, reason: `more than ${maxVertices} vertices` };
  let bad: string | null = null;
  walk(geom, ([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) bad = "non-finite coordinate";
    else if (x < -180 || x > 180 || y < -90 || y > 90) bad = "coordinate out of range";
  });
  if (bad) return { ok: false, reason: bad };
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const rings of polys) {
      for (const ring of rings) {
        if (ring.length < 4) return { ok: false, reason: "ring with fewer than 4 positions" };
        const [fx, fy] = ring[0];
        const [lx, ly] = ring[ring.length - 1];
        if (fx !== lx || fy !== ly) return { ok: false, reason: "ring not closed" };
      }
    }
  }
  if (opts.within) {
    const b = bboxOf(geom);
    const w = opts.within;
    if (b[0] < w[0] || b[1] < w[1] || b[2] > w[2] || b[3] > w[3]) return { ok: false, reason: "outside allowed area" };
  }
  return { ok: true };
}

export function walk(geom: Geometry, fn: (p: Position) => void): void {
  switch (geom.type) {
    case "Point":
      fn(geom.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      geom.coordinates.forEach(fn);
      break;
    case "MultiLineString":
    case "Polygon":
      geom.coordinates.forEach((r) => r.forEach(fn));
      break;
    case "MultiPolygon":
      geom.coordinates.forEach((p) => p.forEach((r) => r.forEach(fn)));
      break;
    case "GeometryCollection":
      geom.geometries.forEach((g) => walk(g, fn));
      break;
  }
}

export function featureCollection<P>(features: Feature<Geometry, P>[]): FeatureCollection<Geometry, P> {
  return { type: "FeatureCollection", features };
}

/** Build a small square polygon (side in metres) around a point; used for point-type alerts. */
export function squareAround(center: { lon: number; lat: number }, sideM: number): Polygon {
  const half = sideM / 2;
  const dLat = half / 110_574;
  const dLon = half / (111_320 * Math.cos(toRad(center.lat)));
  const { lon, lat } = center;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat - dLat],
        [lon + dLon, lat + dLat],
        [lon - dLon, lat + dLat],
        [lon - dLon, lat - dLat],
      ],
    ],
  };
}

export function roundCoord(v: number, places = 5): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
