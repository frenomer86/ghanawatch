/**
 * A plot of land for "Check this land": a circle around a pin for now,
 * represented as a closed lon/lat ring so every analysis can treat drawn
 * plots the same way later. Pure geometry, no I/O.
 */
export type Ring = [number, number][];

export interface Plot {
  center: { lon: number; lat: number };
  radiusM: number;
  ring: Ring;
  bbox: [number, number, number, number];
  areaHa: number;
}

const M_PER_DEG_LAT = 110_574;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export function circlePlot(lon: number, lat: number, radiusM: number, vertices = 64): Plot {
  const ring: Ring = [];
  for (let i = 0; i < vertices; i++) {
    const a = (i / vertices) * 2 * Math.PI;
    ring.push([lon + (radiusM * Math.sin(a)) / mPerDegLon(lat), lat + (radiusM * Math.cos(a)) / M_PER_DEG_LAT]);
  }
  ring.push(ring[0]);
  const dLon = radiusM / mPerDegLon(lat);
  const dLat = radiusM / M_PER_DEG_LAT;
  return {
    center: { lon, lat },
    radiusM,
    ring,
    bbox: [lon - dLon, lat - dLat, lon + dLon, lat + dLat],
    areaHa: (Math.PI * radiusM * radiusM) / 10_000,
  };
}

export function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance in metres from a point to the plot's edge, 0 when inside. */
export function distanceToPlotM(lon: number, lat: number, plot: Plot): number {
  if (pointInRing(lon, lat, plot.ring)) return 0;
  const kx = mPerDegLon(plot.center.lat);
  let best = Infinity;
  for (let i = 0; i < plot.ring.length - 1; i++) {
    const [ax, ay] = plot.ring[i];
    const [bx, by] = plot.ring[i + 1];
    const px = (lon - ax) * kx;
    const py = (lat - ay) * M_PER_DEG_LAT;
    const vx = (bx - ax) * kx;
    const vy = (by - ay) * M_PER_DEG_LAT;
    const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy || 1)));
    best = Math.min(best, Math.hypot(px - t * vx, py - t * vy));
  }
  return best;
}

/** Ground size of one pixel of a Web Mercator tile, in metres, at a latitude. */
export function tilePixelM(z: number, tileSize: number, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (tileSize * 2 ** z);
}

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileToLonLat(x: number, y: number, z: number): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}
