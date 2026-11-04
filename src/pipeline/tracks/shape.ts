import type { Polygon } from "geojson";

/**
 * The shape of a new track cut into forest, shared by the two places GhanaWatch looks for one: Global Forest
 * Watch's alert patches (src/pipeline/adapters/gfw-alerts.ts) and its own 10 m Sentinel-2 scan of forest
 * reserves (src/pipeline/adapters/forest-tracks.ts).
 *
 * A patch of newly cleared pixels is a track when it is at least ROAD_MIN_M long, at most ROAD_MAX_WIDTH_M
 * wide and at least ROAD_MIN_RATIO times longer than wide, and lies mostly against standing forest: a pit or
 * farm that grows adds a thin strip along its edge with the same shape, so a strip with more than
 * ROAD_MAX_EDGE_SHARE of its pixels within two pixels of ground already open before is that edge, not a track.
 */
export const ROAD_MIN_M = 250;
export const ROAD_MAX_WIDTH_M = 35;
export const ROAD_MIN_RATIO = 8;
export const ROAD_MAX_EDGE_SHARE = 0.25;

/**
 * The shape of a patch of pixels along its main axis (pure): the pixels are projected on the principal axis of
 * their spread, grouped in steps of four pixels, and each group's mean position gives a point of the centre
 * line. Length is the length of that line; width is the pixel count over the length. A track that bends gently
 * keeps its length; one that doubles back reads as shorter and wider, so it is not taken for a road (the rule
 * errs towards missing a road rather than inventing one).
 */
export function patchShape(cols: ArrayLike<number>, rows: ArrayLike<number>): { lengthPx: number; widthPx: number; line: Array<[number, number]> } {
  const n = cols.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += cols[i];
    my += rows[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = cols[i] - mx;
    const dy = rows[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const bins = new Map<number, { t: number; s: number; k: number }>();
  for (let i = 0; i < n; i++) {
    const dx = cols[i] - mx;
    const dy = rows[i] - my;
    const t = dx * ux + dy * uy;
    const s = -dx * uy + dy * ux;
    const b = Math.floor(t / 4);
    const e = bins.get(b) ?? { t: 0, s: 0, k: 0 };
    e.t += t;
    e.s += s;
    e.k++;
    bins.set(b, e);
  }
  const line = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => {
      const t = e.t / e.k;
      const s = e.s / e.k;
      return [mx + t * ux - s * uy + 0.5, my + t * uy + s * ux + 0.5] as [number, number];
    });
  let lengthPx = 0;
  for (let i = 1; i < line.length; i++) lengthPx += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  // The end groups stand two pixels in from the ends of the track.
  lengthPx += line.length > 1 ? 4 : 1;
  return { lengthPx, widthPx: n / lengthPx, line };
}

export function isRoadShape(lengthM: number, widthM: number): boolean {
  return lengthM >= ROAD_MIN_M && widthM <= ROAD_MAX_WIDTH_M && lengthM / Math.max(widthM, 1) >= ROAD_MIN_RATIO;
}

/** Share of a patch's pixels with ground already open before (`open(index)` true) within two pixels, on a width × height grid. */
export function edgeShare(open: (i: number) => boolean, width: number, height: number, cols: ArrayLike<number>, rows: ArrayLike<number>): number {
  let touching = 0;
  for (let i = 0; i < cols.length; i++) {
    let hit = false;
    for (let dy = -2; dy <= 2 && !hit; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const c = cols[i] + dx;
        const r = rows[i] + dy;
        if (c >= 0 && r >= 0 && c < width && r < height && open(r * width + c)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) touching++;
  }
  return cols.length ? touching / cols.length : 0;
}

/**
 * The thin parts of a mask: a track usually ends at a clearing (a pit, a camp, a log landing) and joins it, and
 * the two together are no longer track-shaped. Wherever a BLOB_PX square fits wholly inside the mask is the body
 * of a clearing; that body, widened by BLOB_PX - 1 pixels so its ragged rim goes with it, is taken out, and
 * what is left (lines up to BLOB_PX - 1 pixels wide) is returned.
 */
export const BLOB_PX = 5;

export function thinParts(mask: Uint8Array, width: number, height: number): Uint8Array {
  const sat = (m: ArrayLike<number>) => {
    const s = new Int32Array((width + 1) * (height + 1));
    for (let r = 0; r < height; r++) {
      let row = 0;
      for (let c = 0; c < width; c++) {
        row += m[r * width + c] ? 1 : 0;
        s[(r + 1) * (width + 1) + c + 1] = s[r * (width + 1) + c + 1] + row;
      }
    }
    return s;
  };
  const sum = (s: Int32Array, c0: number, r0: number, c1: number, r1: number) => {
    c0 = Math.max(0, c0);
    r0 = Math.max(0, r0);
    c1 = Math.min(width - 1, c1);
    r1 = Math.min(height - 1, r1);
    if (c1 < c0 || r1 < r0) return 0;
    const W = width + 1;
    return s[(r1 + 1) * W + c1 + 1] - s[r0 * W + c1 + 1] - s[(r1 + 1) * W + c0] + s[r0 * W + c0];
  };
  const h = Math.floor(BLOB_PX / 2);
  const ms = sat(mask);
  const core = new Uint8Array(mask.length);
  for (let r = h; r < height - h; r++) {
    for (let c = h; c < width - h; c++) {
      if (mask[r * width + c] && sum(ms, c - h, r - h, c + h, r + h) === BLOB_PX * BLOB_PX) core[r * width + c] = 1;
    }
  }
  const cs = sat(core);
  const reach = h + BLOB_PX - 1;
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (mask[i] && sum(cs, c - reach, r - reach, c + reach, r + reach) === 0) out[i] = 1;
    }
  }
  return out;
}

/** A narrow outline either side of a centre line (lon, lat), `halfM` metres each way, as a closed polygon. */
export function corridor(line: Array<[number, number]>, halfM: number): Polygon {
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const kx = 111_320 * Math.cos((line[i][1] * Math.PI) / 180);
    const ky = 110_540;
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const len = Math.hypot(dx, dy) || 1;
    const ox = (-dy / len) * halfM;
    const oy = (dx / len) * halfM;
    left.push([line[i][0] + ox / kx, line[i][1] + oy / ky]);
    right.push([line[i][0] - ox / kx, line[i][1] - oy / ky]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6])] };
}

export const fmtLength = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
