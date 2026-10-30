import { eq, sql } from "drizzle-orm";
import type { LineString, Point } from "geojson";
import type { Db } from "@/lib/db/client";
import { riverLines } from "@/lib/db/schema";
import { stableId } from "@/lib/server/ids";

/**
 * The rivers radar watches for dredgers, and the structures on them to
 * ignore, from OpenStreetMap via Overpass (Densu, Oda and Bonsa added for the river scorecards). Refreshed monthly by the seed, or
 * on first use by the radar adapter.
 */
export const WATCHED_RIVERS = ["Pra", "Ankobra", "Offin", "Ofin", "Birim", "Tano", "Densu", "Oda", "Bonsa"];

const QUERY = `[out:json][timeout:180];
way["waterway"="river"]["name"~"^(${WATCHED_RIVERS.join("|")})( River)?$"](4.5,-3.4,11.3,1.3)->.r;
.r out geom;
(way["bridge"](around.r:60);way["waterway"~"^(dam|weir)$"](around.r:100);node["waterway"~"^(dam|weir)$"](around.r:100););
out center;`;

interface OsmElement {
  type: "way" | "node";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
}

export async function loadRiverLines(db: Db, fetchText: (url: string, init?: RequestInit) => Promise<string>, log: (s: string) => void) {
  const text = await fetchText("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(QUERY)}`,
    // The query covers the whole country and takes about a minute on the public server.
    signal: AbortSignal.timeout(240_000),
  });
  const els = (JSON.parse(text) as { elements: OsmElement[] }).elements;
  const rows: Array<typeof riverLines.$inferInsert> = [];
  for (const e of els) {
    const isRiver = e.type === "way" && e.tags?.waterway === "river" && e.geometry?.length;
    if (isRiver) {
      const coords = e.geometry!.map((g) => [Number(g.lon.toFixed(6)), Number(g.lat.toFixed(6))]);
      const lons = coords.map((c) => c[0]);
      const lats = coords.map((c) => c[1]);
      const geom: LineString = { type: "LineString", coordinates: coords };
      rows.push({
        id: stableId("river", `way/${e.id}`),
        kind: "river",
        name: (e.tags?.name ?? "").replace(/ River$/, "").replace(/^Ofin$/, "Offin"),
        osmRef: `way/${e.id}`,
        geom,
        bboxMinLon: Math.min(...lons),
        bboxMinLat: Math.min(...lats),
        bboxMaxLon: Math.max(...lons),
        bboxMaxLat: Math.max(...lats),
      });
      continue;
    }
    const c = e.center ?? (e.lat != null && e.lon != null ? { lat: e.lat, lon: e.lon } : null);
    if (!c) continue;
    const geom: Point = { type: "Point", coordinates: [Number(c.lon.toFixed(6)), Number(c.lat.toFixed(6))] };
    rows.push({
      id: stableId("river", `${e.type}/${e.id}`),
      kind: "structure",
      name: e.tags?.bridge ? "bridge" : (e.tags?.waterway ?? "structure"),
      osmRef: `${e.type}/${e.id}`,
      geom,
      bboxMinLon: c.lon,
      bboxMinLat: c.lat,
      bboxMaxLon: c.lon,
      bboxMaxLat: c.lat,
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db
      .insert(riverLines)
      .values(rows.slice(i, i + 200))
      .onConflictDoUpdate({ target: [riverLines.osmRef, riverLines.kind], set: { geom: sql`excluded.geom`, name: sql`excluded.name`, updatedAt: sql`now()` } });
  }
  const rivers = rows.filter((r) => r.kind === "river").length;
  log(`rivers: ${rivers} river sections and ${rows.length - rivers} bridges, dams and weirs`);
}

export async function riverLinesFresh(db: Db): Promise<boolean> {
  const [row] = (await db
    .select({ n: sql<number>`count(*)::int`, at: sql<string | null>`max(${riverLines.updatedAt})` })
    .from(riverLines)
    .where(eq(riverLines.kind, "river"))) as Array<{ n: number; at: string | null }>;
  return Boolean(row && row.n > 0 && row.at && Date.now() - new Date(row.at).getTime() < 30 * 86_400_000);
}
