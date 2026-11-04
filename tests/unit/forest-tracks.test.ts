import { describe, expect, it } from "vitest";
import { boxesForAreas, sameTrack } from "@/pipeline/adapters/forest-tracks";
import type { SceneBands } from "@/pipeline/s2/analysis";
import { findTracks, openedMask, trackComposite } from "@/pipeline/tracks/detect";

/** New tracks into forest from the 10 m Sentinel-2 scan (src/pipeline/tracks/detect.ts, adapters/forest-tracks.ts). */
const W = 120;
const H = 120;
const N = W * H;
type Cover = "forest" | "bare" | "water" | "cloud";
// Surface reflectance of each cover in blue, green, red, near infrared and shortwave infrared, and its scene class.
const REFL: Record<Cover, { b: number[]; scl: number }> = {
  forest: { b: [0.03, 0.06, 0.03, 0.35, 0.15], scl: 4 },
  bare: { b: [0.08, 0.11, 0.16, 0.22, 0.3], scl: 5 },
  water: { b: [0.06, 0.09, 0.07, 0.04, 0.02], scl: 6 },
  cloud: { b: [0.5, 0.5, 0.5, 0.5, 0.4], scl: 9 },
};

function scene(date: string, cover: (c: number, r: number) => Cover): SceneBands {
  const bands = Array.from({ length: 5 }, () => new Uint16Array(N));
  const scl = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const k = cover(i % W, Math.floor(i / W));
    REFL[k].b.forEach((v, j) => (bands[j][i] = Math.round(v * 10_000)));
    scl[i] = REFL[k].scl;
  }
  const [blue, green, red, nir, swir16] = bands;
  return { date, sceneId: date, blue, green, red, nir, swir16, scl, scale: 0.0001, offset: 0 };
}

const forest = () => "forest" as Cover;
/** A track two pixels wide running 45 pixels (450 m) east, with a gentle bend. */
const onTrack = (c: number, r: number) => c >= 30 && c < 75 && Math.abs(r - (60 + Math.round(4 * Math.sin(c / 9)))) <= 0;
const onTrack2 = (c: number, r: number) => onTrack(c, r) || onTrack(c, r - 1);

function run(before: SceneBands[], after: SceneBands[]) {
  const B = trackComposite(before, N);
  const A = trackComposite(after, N);
  return findTracks(openedMask(B, A), B, A, W, H, 10);
}

const baseline = ["2025-01-05", "2025-01-20", "2025-02-04"].map((d) => scene(d, forest));

describe("a new track through forest at 10 m", () => {
  it("finds a track cut through closed forest, with its length and width", () => {
    const after = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) => scene(d, (c, r) => (onTrack2(c, r) ? "bare" : "forest")));
    const tracks = run(baseline, after);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].lengthM).toBeGreaterThan(430);
    expect(tracks[0].lengthM).toBeLessThan(520);
    expect(tracks[0].widthM).toBeLessThanOrEqual(22);
    expect(tracks[0].openObs).toBe(3);
    expect(tracks[0].edge).toBe(0);
  });

  it("keeps a track broken by a tree crown as one", () => {
    const after = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) => scene(d, (c, r) => (onTrack2(c, r) && c !== 50 ? "bare" : "forest")));
    expect(run(baseline, after)).toHaveLength(1);
  });

  it("finds a track that ends in a new clearing", () => {
    const camp = (c: number, r: number) => c >= 75 && c < 92 && r >= 50 && r < 68;
    const after = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) => scene(d, (c, r) => (onTrack2(c, r) || camp(c, r) ? "bare" : "forest")));
    const tracks = run(baseline, after);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].lengthM).toBeGreaterThan(330);
  });

  it("ignores ground that opened on one pass only, as a cloud edge the scene mask missed would", () => {
    const after = [
      scene("2026-10-02", (c, r) => (onTrack2(c, r) ? "bare" : "forest")),
      scene("2026-10-22", forest),
      scene("2026-11-01", forest),
    ];
    expect(run(baseline, after)).toHaveLength(0);
  });

  it("does not take the growing edge of an old clearing for a track", () => {
    const pit = (c: number, r: number) => c >= 30 && c < 75 && r >= 40 && r < 58;
    const before = baseline.map((s) => scene(s.date, (c, r) => (pit(c, r) ? "bare" : "forest")));
    const after = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) => scene(d, (c, r) => (pit(c, r) || (c >= 30 && c < 75 && r >= 58 && r < 60) ? "bare" : "forest")));
    expect(run(before, after)).toHaveLength(0);
  });

  it("leaves a line of water-filled pits along a stream to the pit detectors", () => {
    const after = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) =>
      scene(d, (c, r) => (onTrack2(c, r) ? "bare" : onTrack(c, r - 2) && c % 6 < 3 ? "water" : "forest")),
    );
    expect(run(baseline, after)).toHaveLength(0);
  });

  it("does not report a block of new clearing or a short scrape", () => {
    const block = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) => scene(d, (c, r) => (c >= 40 && c < 60 && r >= 40 && r < 60 ? "bare" : "forest")));
    expect(run(baseline, block)).toHaveLength(0);
    const short = ["2026-10-02", "2026-10-22", "2026-11-01"].map((d) => scene(d, (c, r) => (onTrack2(c, r) && c < 50 ? "bare" : "forest")));
    expect(run(baseline, short)).toHaveLength(0);
  });
});

describe("where the scan looks", () => {
  it("covers each reserve and a 2 km band around it", () => {
    const sq = { type: "Polygon" as const, coordinates: [[[-1.95, 6.11], [-1.93, 6.11], [-1.93, 6.13], [-1.95, 6.13], [-1.95, 6.11]]] };
    const ids = boxesForAreas([{ geom: sq, bbox: [-1.95, 6.11, -1.93, 6.13] }]).map((b) => b.id).sort();
    // The reserve's own box, and the box to the south that its band (6.11 minus 2 km) reaches into.
    expect(ids).toEqual(["t15_15", "t15_16"]);
  });

  it("recognises a track found again on a later pass", () => {
    const line: Array<[number, number]> = [[-0.6, 6.2], [-0.598, 6.2], [-0.596, 6.2]];
    expect(sameTrack(line.map(([x, y]) => [x, y + 0.0003]), line)).toBe(true);
    expect(sameTrack(line.map(([x, y]) => [x, y + 0.002]), line)).toBe(false);
  });
});

describe("reserve outlines from OpenStreetMap", () => {
  it("joins a reserve boundary drawn as several ways, in any direction, into one ring", async () => {
    const { stitchRings } = await import("@/pipeline/context/osm");
    const rings = stitchRings([
      [[0, 0], [1, 0], [1, 1]],
      [[0, 1], [0, 0]],
      [[0, 1], [1, 1]],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual(rings[0].at(-1));
    expect(rings[0]).toHaveLength(5);
  });
});
