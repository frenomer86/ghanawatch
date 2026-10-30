import { inArray, sql } from "drizzle-orm";
import type { LineString, Polygon } from "geojson";
import { rows as toRows, type Db } from "@/lib/db/client";
import { contextFeatures } from "@/lib/db/schema";
import { pointInPolygon } from "@/lib/geo";

/**
 * New clearing or landfill inside waterways and wetlands, for the Floods section. A Sentinel-2 detection of
 * cleared or dug ground whose centre lies within a drain's or canal's buffer (30 m), a river's (60 m),
 * plus half its own width, or inside a mapped wetland or a wetland protected area (Ramsar sites, lagoons), is
 * tagged with that waterway. Tagged detections are shown as possible until someone checks them: at 10 m
 * the scan sees landfill and large structures, not single small buildings.
 */
const BUFFER_M: Record<string, number> = { drain: 30, canal: 30, river: 60 };
const CELL = 0.05;
const NORTH_LAT = 8;
const M_PER_DEG = 111_320;

interface Line {
  name: string | null;
  type: string;
  coords: number[][];
}
interface Area {
  name: string | null;
  kind: "wetland" | "protected_area";
  geom: Polygon;
  bbox: [number, number, number, number];
}

export interface WaterwayTag {
  kind: "drain" | "canal" | "river" | "wetland";
  name: string | null;
  distanceM: number;
}

export class WaterwayIndex {
  private lines = new Map<string, Line[]>();
  private areas: Area[] = [];

  static async load(db: Db): Promise<WaterwayIndex> {
    const idx = new WaterwayIndex();
    const rows = await db
      .select({ kind: contextFeatures.kind, name: contextFeatures.name, geom: contextFeatures.geom })
      .from(contextFeatures)
      .where(inArray(contextFeatures.kind, ["waterway", "wetland", "protected_area"]));
    for (const r of rows) {
      if (!r.geom) continue;
      if (r.kind === "waterway" && r.geom.type === "LineString") {
        const name = r.name && !BUFFER_M[r.name] ? r.name : null;
        const type = r.name && BUFFER_M[r.name] ? r.name : "river";
        idx.addLine({ name, type, coords: (r.geom as LineString).coordinates });
      } else if (r.geom.type === "Polygon") {
        const isWetlandReserve = r.kind === "protected_area" && /ramsar|lagoon|wet ?land|wildlife sanctuary/i.test(r.name ?? "");
        if (r.kind === "wetland" || isWetlandReserve) {
          const ring = (r.geom as Polygon).coordinates[0];
          const xs = ring.map((c) => c[0]);
          const ys = ring.map((c) => c[1]);
          idx.areas.push({ name: r.name, kind: r.kind === "wetland" ? "wetland" : "protected_area", geom: r.geom as Polygon, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
        }
      }
    }
    return idx;
  }

  private addLine(l: Line) {
    const cells = new Set<string>();
    for (const [x, y] of l.coords) cells.add(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`);
    for (const c of cells) {
      const list = this.lines.get(c);
      if (list) list.push(l);
      else this.lines.set(c, [l]);
    }
  }

  /** The waterway or wetland a detection sits in, if any. */
  tag(lon: number, lat: number, radiusM: number): WaterwayTag | null {
    for (const a of this.areas) {
      if (lon < a.bbox[0] || lon > a.bbox[2] || lat < a.bbox[1] || lat > a.bbox[3]) continue;
      if (pointInPolygon([lon, lat], a.geom)) return { kind: "wetland", name: a.name, distanceM: 0 };
    }
    const cx = Math.floor(lon / CELL);
    const cy = Math.floor(lat / CELL);
    const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    let best: WaterwayTag | null = null;
    const seen = new Set<Line>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const l of this.lines.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (seen.has(l)) continue;
          seen.add(l);
          const limit = (BUFFER_M[l.type] ?? 60) + radiusM;
          for (let i = 1; i < l.coords.length; i++) {
            const d = segDistM(lon, lat, l.coords[i - 1], l.coords[i], kx);
            if (d <= limit && (!best || d < best.distanceM)) best = { kind: l.type as WaterwayTag["kind"], name: l.name, distanceM: Math.round(d) };
          }
        }
      }
    }
    return best;
  }
}

function segDistM(lon: number, lat: number, a: number[], b: number[], kx: number): number {
  const px = (lon - a[0]) * kx;
  const py = (lat - a[1]) * M_PER_DEG;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * M_PER_DEG;
  const len = bx * bx + by * by;
  const t = len ? Math.max(0, Math.min(1, (px * bx + py * by) / len)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}

/** Tag every Sentinel-2 clearing or pit detection that lies in a waterway or wetland; clear stale tags. */
export async function tagWaterways(db: Db): Promise<number> {
  const idx = await WaterwayIndex.load(db);
  const rows = toRows<{ id: string; lon: number; lat: number; ha: number; had: boolean; sig: string }>(await db.execute(sql`
    select id::text, centroid_lon::float lon, centroid_lat::float lat, coalesce(area_ha, 0)::float ha, properties ? 'waterway' had, properties->>'signature' sig
    from change_events
    where method_version like 's2-galamsey-%' and type = 'surface_disturbance' and status <> 'dismissed'
      and properties->>'signature' in ('cleared', 'new_pits', 'cleared_with_pits')`));
  // New water in a wetland or lagoon is the season (salt pans, fish ponds, high water), not landfill; and new
  // ponds without clearing are not structures. Only cleared or dug ground counts, and in wetlands only clearing.
  const tags: Array<{ id: string; tag: WaterwayTag }> = [];
  const clear: string[] = [];
  for (const r of rows) {
    // North of 8°N rivers swing between dry and wet seasons and every bank looks new (0 of 12 real in the
    // October 2026 check, against 7 of 8 in the south), so the north is left out for now.
    const t0 = r.sig === "new_pits" || r.lat >= NORTH_LAT ? null : idx.tag(r.lon, r.lat, Math.sqrt(r.ha * 10_000) / 2);
    const t = t0 && t0.kind === "wetland" && r.sig !== "cleared" ? null : t0;
    if (t) tags.push({ id: r.id, tag: t });
    else if (r.had) clear.push(r.id);
  }
  for (let i = 0; i < tags.length; i += 200) {
    const part = tags.slice(i, i + 200);
    await db.execute(sql`
      update change_events e set properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('waterway', v.tag::jsonb)
      from (select x->>'id' as id, x->'tag' as tag from jsonb_array_elements(${JSON.stringify(part)}::text::jsonb) x) v
      where e.id::text = v.id`);
  }
  for (let i = 0; i < clear.length; i += 500) {
    await db.execute(sql`update change_events set properties = properties - 'waterway' where id::text in (select jsonb_array_elements_text(${JSON.stringify(clear.slice(i, i + 500))}::text::jsonb))`);
  }
  return tags.length;
}
