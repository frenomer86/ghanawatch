import { eq, sql } from "drizzle-orm";
import type { Geometry, LineString, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { contextFeatures } from "@/lib/db/schema";
import { stableId } from "@/lib/server/ids";
import { chunk } from "../seed/boundaries";

/**
 * Civilian and environmental context for Ghana from OpenStreetMap, via the
 * public Overpass API (keyless, fair use: three queries, refreshed at most
 * monthly). Data © OpenStreetMap contributors, ODbL.
 */
const OVERPASS = "https://overpass-api.de/api/interpreter";
const AREA = `area["ISO3166-1"="GH"][admin_level=2]->.gh;`;

/** Mines and quarries; only named or operated ones are kept (see kindOf). */
const MINES_QUERY = `[out:json][timeout:300];${AREA}(
    way["landuse"="quarry"](area.gh);
    relation["landuse"="quarry"](area.gh);
    way["industrial"="mine"](area.gh);
    relation["industrial"="mine"](area.gh);
  );out tags geom;`;

const QUERIES = {
  points: `[out:json][timeout:300];${AREA}(
    nwr["amenity"="school"](area.gh);
    nwr["amenity"="grave_yard"](area.gh);
    nwr["landuse"="cemetery"](area.gh);
    nwr["amenity"~"^(hospital|clinic|health_post|doctors)$"](area.gh);
    nwr["amenity"="place_of_worship"](area.gh);
    node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter)$"](area.gh);
  );out center tags;`,
  areas: `[out:json][timeout:300];${AREA}(
    way["landuse"="residential"](area.gh);
    relation["landuse"="residential"](area.gh);
    way["landuse"~"^(farmland|orchard|plantation)$"](area.gh);
  );out tags bb;`,
  protected: `[out:json][timeout:300];${AREA}(
    way["boundary"="protected_area"](area.gh);
    relation["boundary"="protected_area"](area.gh);
    way["leisure"="nature_reserve"](area.gh);
    relation["leisure"="nature_reserve"](area.gh);
  );out tags geom;`,
  mines: MINES_QUERY,
};

/** Rivers, canals and drains, and wetlands, for spotting new clearing or landfill in waterways. */
const WATERWAYS_QUERY = `[out:json][timeout:600];${AREA}(
    way["waterway"~"^(river|canal|drain)$"](area.gh);
    way["natural"="wetland"](area.gh);
    relation["natural"="wetland"](area.gh);
  );out tags geom;`;

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: Array<{ lat: number; lon: number } | null>;
  members?: Array<{ type: string; role: string; geometry?: Array<{ lat: number; lon: number } | null> }>;
  tags?: Record<string, string>;
}

type Kind = (typeof contextFeatures.$inferInsert)["kind"];

/**
 * What a feature is for placing detections. Mines and quarries count only
 * when OpenStreetMap names them or gives an operator (Gold Fields Tarkwa Mine,
 * Subika Pit, Newmont): many unnamed "quarry" areas in Ghana were mapped from
 * galamsey itself, and those are what GhanaWatch is looking for.
 */
export function kindOf(t: Record<string, string>): Kind | null {
  if (t.landuse === "quarry" || t.industrial === "mine") {
    const label = t.name ?? t.operator ?? "";
    return label && !/galamsey/i.test(label) ? "mine" : null;
  }
  if (t.amenity === "school") return "school";
  if (t.amenity === "grave_yard" || t.landuse === "cemetery") return "cemetery";
  if (t.amenity && /^(hospital|clinic|health_post|doctors)$/.test(t.amenity)) return "health";
  if (t.amenity === "place_of_worship") return "worship";
  if (t.place) return "settlement";
  if (t.landuse === "residential") return "residential";
  if (t.landuse && /^(farmland|orchard|plantation)$/.test(t.landuse)) return "farm";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "protected_area";
  return null;
}

/** "Subika Pit (Newmont)", "Gold Fields Tarkwa Mine", or the operator alone. */
function mineName(t: Record<string, string>): string {
  if (t.name && t.operator && !t.name.toLowerCase().includes(t.operator.toLowerCase())) return `${t.name} (${t.operator})`;
  return t.name ?? t.operator;
}

async function overpass(query: string, fetchText: (url: string, init?: RequestInit) => Promise<string>): Promise<OsmElement[]> {
  const body = new URLSearchParams({ data: query }).toString();
  const text = await fetchText(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  return (JSON.parse(text) as { elements: OsmElement[] }).elements ?? [];
}

/**
 * Join the outer ways of a multipolygon relation into closed rings (OSM ways share their end nodes) (pure;
 * exported for tests). A large forest reserve's boundary is often drawn as many ways; taking one of them alone
 * gives a sliver closed by a straight line.
 */
export function stitchRings(parts: number[][][]): number[][][] {
  const key = (p: number[]) => `${p[0]},${p[1]}`;
  const left = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: number[][][] = [];
  while (left.length) {
    const ring = left.shift()!;
    let grown = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grown) {
      grown = false;
      const end = key(ring[ring.length - 1]);
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        if (key(w[0]) === end) ring.push(...w.slice(1));
        else if (key(w[w.length - 1]) === end) ring.push(...[...w].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

const ringArea = (r: number[][]) => {
  let a = 0;
  for (let i = 1; i < r.length; i++) a += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1];
  return Math.abs(a) / 2;
};

function outline(e: OsmElement): Polygon | null {
  const ring = (pts: Array<{ lat: number; lon: number } | null> | undefined) =>
    (pts ?? []).filter((p): p is { lat: number; lon: number } => !!p).map((p) => [p.lon, p.lat]);
  let coords = ring(e.geometry);
  if (!coords.length && e.members) {
    // The largest closed ring of a multipolygon relation's outer ways.
    const rings = stitchRings(e.members.filter((m) => m.role === "outer").map((m) => ring(m.geometry)));
    coords = rings.sort((a, b) => ringArea(b) - ringArea(a))[0] ?? [];
  }
  if (coords.length < 4) return null;
  const [fx, fy] = coords[0];
  const [lx, ly] = coords[coords.length - 1];
  if (fx !== lx || fy !== ly) coords.push([fx, fy]);
  return { type: "Polygon", coordinates: [coords] };
}

export async function loadOsmMines(db: Db, fetchText: (url: string, init?: RequestInit) => Promise<string>, log: (s: string) => void) {
  const rows = toRows(await overpass(MINES_QUERY, fetchText));
  await db.delete(contextFeatures).where(eq(contextFeatures.kind, "mine"));
  for (const batch of chunk(rows, 500)) await db.insert(contextFeatures).values(batch).onConflictDoNothing();
  log(`osm mines: ${rows.length} named mines and quarries`);
}

/**
 * Waterways and wetlands for the Floods section. Waterways keep their line (a river may be split over many
 * OSM ways; each is its own row); wetlands keep their outline. Replaces the previous set.
 */
export async function loadOsmWaterways(db: Db, fetchText: (url: string, init?: RequestInit) => Promise<string>, log: (s: string) => void) {
  const els = await overpass(WATERWAYS_QUERY, fetchText);
  const rows: Array<typeof contextFeatures.$inferInsert> = [];
  for (const e of els) {
    const t = e.tags ?? {};
    const isWetland = t.natural === "wetland";
    let geom: Geometry | null = null;
    if (isWetland) geom = outline(e);
    else {
      const line = (e.geometry ?? []).filter((p): p is { lat: number; lon: number } => !!p).map((p) => [p.lon, p.lat]);
      if (line.length >= 2) geom = { type: "LineString", coordinates: line } as LineString;
    }
    if (!geom) continue;
    const pts = geom.type === "Polygon" ? (geom as Polygon).coordinates[0] : (geom as LineString).coordinates;
    const xs = pts.map((c) => c[0]);
    const ys = pts.map((c) => c[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const osmRef = `${e.type}/${e.id}`;
    const kind = isWetland ? "wetland" : "waterway";
    rows.push({
      id: stableId("osm", `${osmRef}:${kind}`),
      kind,
      // Waterways carry their type in the name when unnamed, so a drain reads as "drain".
      name: (t.name ?? t["name:en"] ?? (isWetland ? t.wetland ?? null : t.waterway))?.slice(0, 200) ?? null,
      osmRef,
      centroidLon: (bbox[0] + bbox[2]) / 2,
      centroidLat: (bbox[1] + bbox[3]) / 2,
      bboxMinLon: bbox[0],
      bboxMinLat: bbox[1],
      bboxMaxLon: bbox[2],
      bboxMaxLat: bbox[3],
      geom,
    });
  }
  if (rows.length < 100) throw new Error(`Overpass returned only ${rows.length} waterways; keeping the existing set`);
  await db.delete(contextFeatures).where(sql`${contextFeatures.kind} in ('waterway', 'wetland')`);
  for (const batch of chunk(rows, 500)) await db.insert(contextFeatures).values(batch).onConflictDoNothing();
  log(`osm waterways: ${rows.filter((r) => r.kind === "waterway").length} river, canal and drain lines, ${rows.filter((r) => r.kind === "wetland").length} wetlands`);
}

/** Context rows from Overpass elements, keeping only the kinds GhanaWatch uses. */
function toRows(els: OsmElement[]): Array<typeof contextFeatures.$inferInsert> {
  const rows: Array<typeof contextFeatures.$inferInsert> = [];
  for (const e of els) {
    const t = e.tags ?? {};
    const kind = kindOf(t);
    if (!kind) continue;
    const lat = e.center?.lat ?? e.lat ?? (e.bounds ? (e.bounds.minlat + e.bounds.maxlat) / 2 : undefined);
    const lon = e.center?.lon ?? e.lon ?? (e.bounds ? (e.bounds.minlon + e.bounds.maxlon) / 2 : undefined);
    let geom: Polygon | null = null;
    let bbox = e.bounds ? [e.bounds.minlon, e.bounds.minlat, e.bounds.maxlon, e.bounds.maxlat] : null;
    if (kind === "protected_area" || kind === "mine") {
      geom = outline(e);
      if (geom) {
        const xs = geom.coordinates[0].map((c) => c[0]);
        const ys = geom.coordinates[0].map((c) => c[1]);
        bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
    }
    const cLon = lon ?? (bbox ? (bbox[0] + bbox[2]) / 2 : undefined);
    const cLat = lat ?? (bbox ? (bbox[1] + bbox[3]) / 2 : undefined);
    if (cLon == null || cLat == null) continue;
    const osmRef = `${e.type}/${e.id}`;
    rows.push({
      id: stableId("osm", `${osmRef}:${kind}`),
      kind,
      name: (kind === "mine" ? mineName(t) : (t.name ?? t["name:en"] ?? null))?.slice(0, 200) ?? null,
      osmRef,
      centroidLon: cLon,
      centroidLat: cLat,
      bboxMinLon: bbox?.[0] ?? null,
      bboxMinLat: bbox?.[1] ?? null,
      bboxMaxLon: bbox?.[2] ?? null,
      bboxMaxLat: bbox?.[3] ?? null,
      geom,
    });
  }
  return rows;
}

export async function loadOsmContext(db: Db, fetchText: (url: string, init?: RequestInit) => Promise<string>, log: (s: string) => void) {
  const rows: Array<typeof contextFeatures.$inferInsert> = [];
  for (const [name, q] of Object.entries(QUERIES)) {
    const part = toRows(await overpass(q, fetchText));
    rows.push(...part);
    log(`osm ${name}: ${part.length} features`);
  }
  if (rows.length < 1000) throw new Error(`Overpass returned only ${rows.length} features; keeping the existing context`);
  await db.delete(contextFeatures).where(sql`${contextFeatures.kind} not in ('waterway', 'wetland')`);
  for (const batch of chunk(rows, 500)) {
    await db.insert(contextFeatures).values(batch).onConflictDoNothing();
  }
  const counts = await db.select({ kind: contextFeatures.kind, n: sql<number>`count(*)::int` }).from(contextFeatures).groupBy(contextFeatures.kind);
  log(`osm context: ${counts.map((c) => `${c.kind} ${c.n}`).join(", ")}`);
}
