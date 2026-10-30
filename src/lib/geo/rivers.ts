import type { LineString, MultiLineString } from "geojson";
import { haversineKm } from "./index";

/**
 * Distance from a point to river centre lines, and the division of a river into reaches of equal
 * length for the river scorecards. Pure geometry; the lines come from river_lines (OpenStreetMap).
 */
export interface RiverLine {
  river: string;
  coords: number[][];
}

export function riverLinesFromGeom(river: string, geom: LineString | MultiLineString): RiverLine[] {
  if (geom.type === "LineString") return [{ river, coords: geom.coordinates }];
  return geom.coordinates.map((coords) => ({ river, coords }));
}

const M_PER_DEG_LAT = 111_320;

/** Metres from a point to the nearest point on a polyline (flat-earth, fine at this scale). */
export function distanceToLineM(lon: number, lat: number, coords: number[][]): number {
  const kx = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const ax = (x1 - lon) * kx;
    const ay = (y1 - lat) * ky;
    const bx = (x2 - lon) * kx;
    const by = (y2 - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < best) best = d;
  }
  return best;
}

/** A spatial index over many river lines so thousands of points can be tested quickly. */
export class RiverIndex {
  private cells = new Map<string, RiverLine[]>();
  private static CELL = 0.05;

  constructor(readonly lines: RiverLine[]) {
    const c = RiverIndex.CELL;
    for (const l of lines) {
      const seen = new Set<string>();
      for (const [lon, lat] of l.coords) {
        for (let x = Math.floor(lon / c) - 1; x <= Math.floor(lon / c) + 1; x++) {
          for (let y = Math.floor(lat / c) - 1; y <= Math.floor(lat / c) + 1; y++) {
            const k = `${x}:${y}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const list = this.cells.get(k);
            if (list) list.push(l);
            else this.cells.set(k, [l]);
          }
        }
      }
    }
  }

  /** The nearest river within `withinM`, or null. */
  nearest(lon: number, lat: number, withinM: number): { river: string; distanceM: number } | null {
    const c = RiverIndex.CELL;
    const list = this.cells.get(`${Math.floor(lon / c)}:${Math.floor(lat / c)}`) ?? [];
    let best: { river: string; distanceM: number } | null = null;
    for (const l of list) {
      const d = distanceToLineM(lon, lat, l.coords);
      if (d <= withinM && (!best || d < best.distanceM)) best = { river: l.river, distanceM: Math.round(d) };
    }
    return best;
  }
}

export interface Reach {
  river: string;
  /** Position along the river, 1 = most upstream section in the line order. */
  n: number;
  startKm: number;
  endKm: number;
  /** Centre of the reach. */
  lon: number;
  lat: number;
  coords: number[][];
}

/** Cut a river's lines into reaches of about `km` kilometres each, in line order. */
/**
 * Puts a river's mapped sections in order along the water. Public river maps come as many short pieces in
 * no particular order; starting from the piece whose end is farthest from everything else, each next piece
 * is the one whose start (or, reversed, end) lies closest to where the last one stopped. Pieces that join
 * end to end are merged into one continuous line; a gap longer than `joinKm` starts a new line.
 */
export function chainSections(lines: RiverLine[], joinKm = 2): RiverLine[] {
  const pieces = lines.filter((l) => l.coords.length >= 2).map((l) => ({ ...l, coords: [...l.coords] }));
  if (pieces.length <= 1) return pieces;
  const pt = (c: number[]) => ({ lon: c[0], lat: c[1] });
  const d = (a: number[], b: number[]) => haversineKm(pt(a), pt(b));
  // The head of the river: the piece end that is farthest from any other piece's end.
  let startIdx = 0;
  let startReversed = false;
  let best = -1;
  pieces.forEach((p, i) => {
    for (const [end, reversed] of [
      [p.coords[0], false],
      [p.coords[p.coords.length - 1], true],
    ] as const) {
      let nearest = Infinity;
      pieces.forEach((q, j) => {
        if (i === j) return;
        nearest = Math.min(nearest, d(end, q.coords[0]), d(end, q.coords[q.coords.length - 1]));
      });
      if (nearest > best) {
        best = nearest;
        startIdx = i;
        startReversed = reversed;
      }
    }
  });
  const used = new Set<number>([startIdx]);
  const first = pieces[startIdx];
  let current: RiverLine = { ...first, coords: startReversed ? [...first.coords].reverse() : first.coords };
  const out: RiverLine[] = [];
  while (used.size < pieces.length) {
    const tail = current.coords[current.coords.length - 1];
    let pick = -1;
    let pickReversed = false;
    let pickD = Infinity;
    pieces.forEach((q, j) => {
      if (used.has(j)) return;
      const ds = d(tail, q.coords[0]);
      const de = d(tail, q.coords[q.coords.length - 1]);
      if (ds < pickD) {
        pickD = ds;
        pick = j;
        pickReversed = false;
      }
      if (de < pickD) {
        pickD = de;
        pick = j;
        pickReversed = true;
      }
    });
    used.add(pick);
    const q = pieces[pick];
    const coords = pickReversed ? [...q.coords].reverse() : q.coords;
    if (pickD <= joinKm) current = { ...current, coords: [...current.coords, ...coords] };
    else {
      out.push(current);
      current = { ...q, coords };
    }
  }
  out.push(current);
  return out;
}

/** Cuts a river into reaches of about `km`, numbered and measured from the head of the river downwards. */
export function reaches(lines: RiverLine[], km = 10): Reach[] {
  const out: Reach[] = [];
  let n = 0;
  let acc = 0;
  for (const l of chainSections(lines)) {
    let startKm = acc;
    let current: number[][] = [l.coords[0]];
    for (let i = 1; i < l.coords.length; i++) {
      const [x1, y1] = l.coords[i - 1];
      const [x2, y2] = l.coords[i];
      acc += haversineKm({ lon: x1, lat: y1 }, { lon: x2, lat: y2 });
      current.push(l.coords[i]);
      if (acc - startKm >= km || i === l.coords.length - 1) {
        const last = out[out.length - 1];
        if (i === l.coords.length - 1 && acc - startKm < km * 0.3 && last && last.river === l.river && last.endKm === Math.round(startKm)) {
          // A short tail at the end of a line joins the reach before it rather than standing alone.
          last.endKm = Math.round(acc);
          last.coords = [...last.coords, ...current.slice(1)];
        } else {
          const mid = current[Math.floor(current.length / 2)];
          out.push({ river: l.river, n: ++n, startKm: Math.round(startKm), endKm: Math.round(acc), lon: mid[0], lat: mid[1], coords: current });
        }
        startKm = acc;
        current = [l.coords[i]];
      }
    }
  }
  return out;
}

export function riverLengthKm(lines: RiverLine[]): number {
  let km = 0;
  for (const l of lines) {
    for (let i = 1; i < l.coords.length; i++) {
      const [x1, y1] = l.coords[i - 1];
      const [x2, y2] = l.coords[i];
      km += haversineKm({ lon: x1, lat: y1 }, { lon: x2, lat: y2 });
    }
  }
  return Math.round(km);
}
