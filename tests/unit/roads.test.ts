import { describe, expect, it } from "vitest";
import { patchesInTile } from "@/pipeline/adapters/gfw-alerts";
import { corridor, edgeShare, isRoadShape, patchShape } from "@/pipeline/tracks/shape";
import { placeRoad, roadTitle, type Reserve } from "@/pipeline/context/roads";

/** New tracks into forest: recognising a track among forest-loss alerts, and placing it against the reserves. */
const PX = 9.5; // metres per alert pixel near 6° N at zoom 14

function line(points: Array<[number, number]>) {
  const cols: number[] = [];
  const rows: number[] = [];
  for (const [c, r] of points) {
    cols.push(c);
    rows.push(r);
  }
  return { cols, rows };
}

describe("track shape", () => {
  it("measures a straight diagonal track one pixel wide", () => {
    const pts = Array.from({ length: 40 }, (_, i) => [10 + i, 20 + i] as [number, number]);
    const { cols, rows } = line(pts);
    const s = patchShape(cols, rows);
    expect(s.lengthPx).toBeGreaterThan(54);
    expect(s.lengthPx).toBeLessThan(60);
    expect(isRoadShape(s.lengthPx * PX, s.widthPx * PX)).toBe(true);
  });

  it("follows a gently bending track three pixels wide", () => {
    const pts: Array<[number, number]> = [];
    for (let c = 0; c < 60; c++) {
      const r = 50 + Math.round(8 * Math.sin(c / 20));
      for (let w = 0; w < 3; w++) pts.push([c, r + w]);
    }
    const { cols, rows } = line(pts);
    const s = patchShape(cols, rows);
    expect(s.widthPx).toBeLessThan(3.5);
    expect(isRoadShape(s.lengthPx * PX, s.widthPx * PX)).toBe(true);
  });

  it("does not take a pit, a block of farm clearing or a short scrape for a track", () => {
    const blob: Array<[number, number]> = [];
    for (let c = 0; c < 15; c++) for (let r = 0; r < 15; r++) blob.push([c, r]);
    const b = patchShape(line(blob).cols, line(blob).rows);
    expect(isRoadShape(b.lengthPx * PX, b.widthPx * PX)).toBe(false);
    const field: Array<[number, number]> = [];
    for (let c = 0; c < 40; c++) for (let r = 0; r < 8; r++) field.push([c, r]);
    const f = patchShape(line(field).cols, line(field).rows);
    expect(isRoadShape(f.lengthPx * PX, f.widthPx * PX)).toBe(false);
    const short = Array.from({ length: 18 }, (_, i) => [i, 3] as [number, number]);
    const sh = patchShape(line(short).cols, line(short).rows);
    expect(isRoadShape(sh.lengthPx * PX, sh.widthPx * PX)).toBe(false);
  });

  it("marks a track-shaped patch in an alert tile and keeps its centre line", () => {
    const g = new Int32Array(256 * 256);
    for (let i = 0; i < 70; i++) g[(30 + Math.floor(i / 3)) * 256 + 20 + i] = 4100 * 4 + 2;
    for (let c = 150; c < 165; c++) for (let r = 150; r < 165; r++) g[r * 256 + c] = 4100 * 4 + 2;
    const patches = patchesInTile(g, 8104, 7856);
    const road = patches.find((p) => p.road);
    const pit = patches.find((p) => !p.road);
    expect(road?.road?.lengthM).toBeGreaterThan(600);
    expect(road?.road?.widthM).toBeLessThanOrEqual(12);
    expect(road?.road?.line.length).toBeGreaterThan(10);
    expect(pit?.pixels).toBe(225);
  });

  it("does not take the new edge of an old clearing for a track", () => {
    const g = new Int32Array(256 * 256);
    // An old pit (alerts before the window, -1) and a strip of new alerts along its southern edge.
    for (let r = 40; r < 70; r++) for (let c = 20; c < 110; c++) g[r * 256 + c] = -1;
    for (let c = 20; c < 110; c++) for (let r = 70; r < 72; r++) g[r * 256 + c] = 4100 * 4 + 2;
    const patches = patchesInTile(g, 8104, 7856);
    expect(patches).toHaveLength(1);
    expect(patches[0].pixels).toBe(180);
    expect(patches[0].road).toBeUndefined();
    // The same strip with the old pit 30 pixels away is a track; one touching it only at an end still is.
    const h = new Int32Array(256 * 256);
    for (let r = 10; r < 38; r++) for (let c = 20; c < 110; c++) h[r * 256 + c] = -1;
    for (let c = 20; c < 110; c++) for (let r = 70; r < 72; r++) h[r * 256 + c] = 4100 * 4 + 2;
    for (let r = 72; r < 76; r++) for (let c = 105; c < 115; c++) h[r * 256 + c] = -1;
    expect(patchesInTile(h, 8104, 7856)[0].road).toBeDefined();
    expect(edgeShare((i) => h[i] < 0, 256, 256, [20, 21], [70, 70])).toBe(0);
  });

  it("draws a narrow outline either side of the centre line", () => {
    const poly = corridor([[-1.7, 6.2], [-1.69, 6.2]], 10);
    const ring = poly.coordinates[0];
    expect(ring[0]).toEqual(ring.at(-1));
    const lats = ring.map((p) => p[1]);
    expect((Math.max(...lats) - Math.min(...lats)) * 110_540).toBeCloseTo(20, 0);
  });
});

describe("placing a track against the reserves", () => {
  const sq = (w: number, s: number, e: number, n: number) => ({ type: "Polygon" as const, coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const reserves: Reserve[] = [{ name: "Atewa Range Forest Reserve", geom: sq(-0.6, 6.1, -0.5, 6.3), bbox: [-0.6, 6.1, -0.5, 6.3] }];

  it("raises a track inside a reserve, and to urgent when mining is within 2 km", () => {
    const inside: Array<[number, number]> = [[-0.58, 6.2], [-0.56, 6.21]];
    expect(placeRoad(inside, reserves, null)).toMatchObject({ reserve: "Atewa Range Forest Reserve", inside: true, severity: "elevated" });
    expect(placeRoad(inside, reserves, 1500).severity).toBe("urgent");
    expect(placeRoad(inside, reserves, 3500).severity).toBe("elevated");
    expect(roadTitle(1800, placeRoad(inside, reserves, null))).toBe("New track cut into Atewa Range Forest Reserve, about 1.8 km");
  });

  it("watches a track that stops within 1 km of a reserve's edge", () => {
    const outside: Array<[number, number]> = [[-0.64, 6.2], [-0.606, 6.2]];
    const p = placeRoad(outside, reserves, null);
    expect(p).toMatchObject({ inside: false, severity: "watch", reserve: "Atewa Range Forest Reserve" });
    expect(p.distanceM).toBeGreaterThan(600);
    expect(p.distanceM).toBeLessThan(700);
    expect(roadTitle(400, p)).toBe("New track reaching Atewa Range Forest Reserve, about 400 m, 660 m from its edge");
  });

  it("leaves a track far from any reserve at normal", () => {
    expect(placeRoad([[-1.5, 7], [-1.49, 7]], reserves, null)).toEqual({ reserve: null, inside: false, distanceM: null, severity: "normal" });
  });
});
