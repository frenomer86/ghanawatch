import type { MultiPolygon, Polygon, Position } from "geojson";

/**
 * Outline handling for the reservoir monitor: Douglas–Peucker simplification (Lake Volta's outline has
 * 177,000 vertices at Landsat's 30 m; at a 200 m radar grid a few thousand do) and an even–odd scanline fill
 * of a polygon with holes onto a grid, which costs time in proportion to the rows each edge crosses rather
 * than rows times edges.
 */

/** Douglas–Peucker on one ring (closed or not), keeping the ends; `tol` in the ring's units. */
export function simplifyRing(ring: Position[], tol: number): Position[] {
  const n = ring.length;
  if (n <= 4 || tol <= 0) return ring;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d2: number;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2;
      }
      if (d2 > worstD) {
        worstD = d2;
        worst = i;
      }
    }
    if (worst >= 0 && worstD > tol2) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  // A ring needs at least a triangle; a tiny ring that collapses is dropped by the caller.
  return out;
}

export function simplifyPolygon(g: Polygon | MultiPolygon, tol: number): MultiPolygon {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const out: Position[][][] = [];
  for (const p of polys) {
    const outer = simplifyRing(p[0] ?? [], tol);
    // The whole polygon is smaller than the tolerance: nothing of it would fill a pixel.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of outer) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    if (outer.length < 4 || (x1 - x0 < tol && y1 - y0 < tol)) continue;
    out.push([outer, ...p.slice(1).map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 4)]);
  }
  return { type: "MultiPolygon", coordinates: out };
}

export function vertexCount(g: Polygon | MultiPolygon): number {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.reduce((a, p) => a + p.reduce((b, r) => b + r.length, 0), 0);
}

/**
 * Pixels of a width x height grid whose centres fall inside the polygon (even–odd rule, so holes are holes).
 * `rings` are in grid pixel coordinates: x to the right, y downward, pixel (c, r) centred on (c + 0.5, r + 0.5).
 */
export function rasterise(rings: Position[][], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const xs: number[][] = Array.from({ length: height }, () => []);
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      if (y0 === y1) continue;
      const yLo = Math.min(y0, y1);
      const yHi = Math.max(y0, y1);
      // Rows whose centre y = r + 0.5 lies in [yLo, yHi).
      const rStart = Math.max(0, Math.ceil(yLo - 0.5));
      const rEnd = Math.min(height - 1, Math.ceil(yHi - 0.5) - 1);
      for (let r = rStart; r <= rEnd; r++) {
        const yc = r + 0.5;
        xs[r].push(x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
  }
  for (let r = 0; r < height; r++) {
    const row = xs[r];
    if (row.length < 2) continue;
    row.sort((a, b) => a - b);
    for (let k = 0; k + 1 < row.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(row[k] - 0.5));
      const c1 = Math.min(width - 1, Math.ceil(row[k + 1] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) mask[r * width + c] = 1;
    }
  }
  return mask;
}

/** Square dilation of a 0/1 mask by k pixels (two separable passes). */
export function dilate(mask: Uint8Array, width: number, height: number, k: number): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  for (let r = 0; r < height; r++) {
    let last = -Infinity;
    for (let c = 0; c < width; c++) {
      if (mask[r * width + c]) last = c;
      if (c - last <= k) tmp[r * width + c] = 1;
    }
    last = Infinity;
    for (let c = width - 1; c >= 0; c--) {
      if (mask[r * width + c]) last = c;
      if (last - c <= k) tmp[r * width + c] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let c = 0; c < width; c++) {
    let last = -Infinity;
    for (let r = 0; r < height; r++) {
      if (tmp[r * width + c]) last = r;
      if (r - last <= k) out[r * width + c] = 1;
    }
    last = Infinity;
    for (let r = height - 1; r >= 0; r--) {
      if (tmp[r * width + c]) last = r;
      if (last - r <= k) out[r * width + c] = 1;
    }
  }
  return out;
}
