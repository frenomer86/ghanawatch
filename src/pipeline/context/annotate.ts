import { notInArray } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { contextFeatures } from "@/lib/db/schema";
import { haversineKm, pointInPolygon } from "@/lib/geo";

/**
 * Where a detection sits relative to people and protected land.
 * Built once per pipeline run from context_features (OpenStreetMap).
 */
export interface Nearby {
  kind: "school" | "cemetery" | "health" | "worship" | "settlement" | "mine";
  name: string | null;
  distanceM: number;
}

export interface Placement {
  inResidential: boolean;
  onFarmland: boolean;
  protectedArea: string | null;
  /** Named mine or quarry the detection lies in, such as "Subika Pit (Newmont)". */
  mine: string | null;
  nearby: Nearby[];
  /** Short labels for cards, most important first. */
  flags: string[];
}

const RADIUS_M: Record<Nearby["kind"], number> = { school: 500, cemetery: 500, health: 500, worship: 300, settlement: 1500, mine: 300 };
const CELL = 0.02; // grid bucket, about 2.2 km

export interface Feat {
  kind: string;
  name: string | null;
  lon: number;
  lat: number;
  bbox: [number, number, number, number] | null;
  geom: Polygon | MultiPolygon | null;
}

export class ContextIndex {
  private buckets = new Map<string, Feat[]>();
  private protectedAreas: Feat[] = [];
  private mines: Feat[] = [];
  readonly size: number;

  private constructor(feats: Feat[]) {
    this.size = feats.length;
    for (const f of feats) {
      if (f.kind === "protected_area" || f.kind === "mine") {
        if (f.geom) (f.kind === "mine" ? this.mines : this.protectedAreas).push(f);
        continue;
      }
      // Areas are indexed in every bucket their bbox touches; points in one.
      const b = f.bbox ?? [f.lon, f.lat, f.lon, f.lat];
      for (let x = Math.floor(b[0] / CELL); x <= Math.floor(b[2] / CELL); x++) {
        for (let y = Math.floor(b[1] / CELL); y <= Math.floor(b[3] / CELL); y++) {
          const k = `${x}:${y}`;
          if (!this.buckets.has(k)) this.buckets.set(k, []);
          this.buckets.get(k)!.push(f);
        }
      }
    }
  }

  /** For tests and scripts that already hold the features. */
  static of(feats: Feat[]): ContextIndex {
    return new ContextIndex(feats);
  }

  static async load(db: Db): Promise<ContextIndex> {
    // Waterways and wetlands serve the Floods section, not detection placement.
    const rows = await db.select().from(contextFeatures).where(notInArray(contextFeatures.kind, ["waterway", "wetland"]));
    return new ContextIndex(
      rows.map((r) => ({
        kind: r.kind,
        name: r.name,
        lon: r.centroidLon,
        lat: r.centroidLat,
        bbox: r.bboxMinLon != null ? [r.bboxMinLon, r.bboxMinLat!, r.bboxMaxLon!, r.bboxMaxLat!] : null,
        geom: (r.geom as Polygon | MultiPolygon | null) ?? null,
      })),
    );
  }

  place(lon: number, lat: number): Placement {
    const seen = new Set<Feat>();
    const nearest = new Map<Nearby["kind"], Nearby>();
    let inResidential = false;
    let onFarmland = false;
    const bx = Math.floor(lon / CELL);
    const by = Math.floor(lat / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const f of this.buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
          if (seen.has(f)) continue;
          seen.add(f);
          if (f.kind === "residential" || f.kind === "farm") {
            const b = f.bbox;
            if (b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) {
              if (f.kind === "residential") inResidential = true;
              else onFarmland = true;
            }
            continue;
          }
          const kind = f.kind as Nearby["kind"];
          const d = Math.round(haversineKm({ lon, lat }, { lon: f.lon, lat: f.lat }) * 1000);
          if (d > RADIUS_M[kind]) continue;
          const cur = nearest.get(kind);
          if (!cur || d < cur.distanceM) nearest.set(kind, { kind, name: f.name, distanceM: d });
        }
      }
    }
    let protectedArea: string | null = null;
    for (const p of this.protectedAreas) {
      const b = p.bbox;
      if (b && (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3])) continue;
      if (p.geom && pointInPolygon([lon, lat], p.geom)) {
        protectedArea = p.name ?? "a protected area";
        break;
      }
    }
    const mine = this.inside(this.mines, lon, lat);
    // Just outside a mapped mine: often the mine growing past its mapped edge.
    const edge = mine ? null : this.nearestEdge(this.mines, lon, lat, RADIUS_M.mine);
    if (edge) nearest.set("mine", { kind: "mine", ...edge });
    const nearby = [...nearest.values()].sort((a, b) => a.distanceM - b.distanceM);
    const flags: string[] = [];
    if (protectedArea) flags.push(`Inside ${protectedArea}`);
    if (mine) flags.push(`Inside ${mine}, a mapped mine or quarry`);
    else if (edge) flags.push(`${edge.distanceM} m from ${edge.name}, a mapped mine or quarry`);
    const school = nearest.get("school");
    if (school) flags.push(`${school.distanceM} m from ${school.name ?? "a school"}`);
    if (inResidential) flags.push("Inside a residential area");
    const cemetery = nearest.get("cemetery");
    if (cemetery) flags.push(`${cemetery.distanceM} m from ${cemetery.name ?? "a cemetery"}`);
    const health = nearest.get("health");
    if (health) flags.push(`${health.distanceM} m from ${health.name ?? "a health facility"}`);
    if (onFarmland) flags.push("On mapped farmland");
    const settlement = nearest.get("settlement");
    if (settlement && !inResidential) flags.push(`${settlement.distanceM} m from ${settlement.name ?? "a settlement"}`);
    return { inResidential, onFarmland, protectedArea, mine, nearby, flags };
  }

  private nearestEdge(areas: Feat[], lon: number, lat: number, maxM: number): { name: string; distanceM: number } | null {
    const pad = maxM / 110_000;
    let best: { name: string; distanceM: number } | null = null;
    for (const a of areas) {
      const b = a.bbox;
      if (!b || !a.geom || lon < b[0] - pad || lon > b[2] + pad || lat < b[1] - pad || lat > b[3] + pad) continue;
      const rings = a.geom.type === "Polygon" ? [a.geom.coordinates[0]] : a.geom.coordinates.map((p) => p[0]);
      for (const ring of rings) {
        const d = Math.round(ringDistanceM(lon, lat, ring));
        if (d <= maxM && (!best || d < best.distanceM)) best = { name: a.name ?? "a mapped mine", distanceM: d };
      }
    }
    return best;
  }

  private inside(areas: Feat[], lon: number, lat: number): string | null {
    for (const a of areas) {
      const b = a.bbox;
      if (b && (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3])) continue;
      if (a.geom && pointInPolygon([lon, lat], a.geom)) return a.name ?? "a mapped mine";
    }
    return null;
  }
}

/** Distance in metres from a point outside a ring to its nearest edge (flat-earth, fine at this scale). */
function ringDistanceM(lon: number, lat: number, ring: number[][]): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const px = (lon - ax) * kx;
    const py = (lat - ay) * ky;
    const vx = (bx - ax) * kx;
    const vy = (by - ay) * ky;
    const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy || 1)));
    best = Math.min(best, Math.hypot(px - t * vx, py - t * vy));
  }
  return best;
}

/** Civilian or protected setting: used to raise the risk level of land-disturbance detections. */
export function isSensitive(p: Placement): boolean {
  return (
    !!p.protectedArea ||
    p.inResidential ||
    p.nearby.some((n) => (n.kind === "school" || n.kind === "cemetery" || n.kind === "health") && n.distanceM <= 300)
  );
}
