import { sql } from "drizzle-orm";
import type { LineString, MultiLineString } from "geojson";
import { getDb, rows as toRows } from "@/lib/db/client";
import { scoreKind } from "@/lib/domain/scorecards";
import { assignSites, type Sighting, type Site } from "@/lib/domain/sites";
import { monthOf, type IndexDistrict } from "@/lib/domain/index";
import { RiverIndex, riverLinesFromGeom } from "@/lib/geo/rivers";
import { loadDistrictInfo } from "@/lib/db/repo/scorecards";

/** Within this many metres of a watched river's centre line a site counts as on the river. */
export const RIVER_BUFFER_M = 100;

interface Row {
  id: string;
  month: string;
  lon: number;
  lat: number;
  ha: number | null;
  district_id: string | null;
  type: string;
  method_version: string;
  sig: string | null;
  confidence: string;
  reserve: string | null;
  mine: string | null;
  licensed: string | null;
  licence: string | null;
}

/**
 * Every sighting the index can count: the historical scan (one row per site per scan month) and the live
 * detections (counted in the month of their first satellite date). Both are folded into sites.
 */
export async function loadSites(): Promise<{ sites: Site[]; districts: IndexDistrict[]; legalityKnown: boolean; rivers: RiverIndex }> {
  const db = await getDb();
  const districts = await loadDistrictInfo();
  const rivers = await loadRiverIndex();
  const history = toRows<Row>(
    await db.execute(sql`
      select id::text, scan_month as month, centroid_lon::float lon, centroid_lat::float lat, area_ha::float ha, district_id::text,
        type, method_version, properties->>'signature' sig, confidence,
        properties->'placement'->>'protectedArea' reserve, properties->'placement'->>'mine' mine,
        properties->>'licensedMine' licensed, properties->>'licence' licence
      from history_events where centroid_lon is not null`),
  );
  const live = toRows<Row>(
    await db.execute(sql`
      select id::text, to_char(coalesce(first_image_date, image_date), 'YYYY-MM') as month, centroid_lon::float lon, centroid_lat::float lat,
        area_ha::float ha, district_id::text, type, method_version, properties->>'signature' sig, confidence,
        properties->'placement'->>'protectedArea' reserve, properties->'placement'->>'mine' mine,
        properties->>'licensedMine' licensed, properties->>'licence' licence
      from change_events
      where status <> 'dismissed' and centroid_lon is not null
        and (method_version like 's2-galamsey-%' or method_version like 's1-water-%')`),
  );
  const [cad] = toRows<{ n: number }>(await db.execute(sql`select count(*)::int n from context_features where kind = 'licence'`));
  const legalityKnown = Number(cad?.n ?? 0) > 0;
  const toSighting = (r: Row): Sighting => {
    const k = scoreKind({ type: r.type, methodVersion: r.method_version, signature: r.sig, confidence: r.confidence });
    const inMine = Boolean(r.mine || r.licensed);
    const legality: Sighting["legality"] = inMine ? "licensed" : r.licence ? "licensed" : legalityKnown ? "unlicensed" : "unknown";
    return {
      id: r.id,
      month: r.month,
      lon: Number(r.lon),
      lat: Number(r.lat),
      areaHa: Number(r.ha ?? 0),
      districtId: r.district_id,
      likely: k.likely,
      inReserve: Boolean(r.reserve),
      reserve: r.reserve,
      inRiverBuffer: rivers.nearest(Number(r.lon), Number(r.lat), RIVER_BUFFER_M) !== null,
      legality,
      inMine,
    };
  };
  const sightings = [...history, ...live].filter((r) => /^20\d\d-\d\d$/.test(r.month)).map(toSighting);
  return { sites: assignSites(sightings), districts, legalityKnown, rivers };
}

export async function loadRiverIndex(): Promise<RiverIndex> {
  const db = await getDb();
  const rows = toRows<{ name: string | null; geom: LineString | MultiLineString }>(await db.execute(sql`select name, geom from river_lines where kind = 'river' and geom is not null`));
  return new RiverIndex(rows.flatMap((r) => riverLinesFromGeom(r.name ?? "river", r.geom)));
}

/**
 * The first month of the series: the earliest sighting, the earliest month already closed, or the month
 * being closed, whichever is first; never before 2019-01. A month with no sightings still closes, at zero.
 */
export function seriesStart(sites: Site[], ...alsoFrom: (string | null | undefined)[]): string {
  let first = monthOf(new Date());
  for (const m of alsoFrom) if (m && m < first) first = m;
  for (const s of sites) if (s.firstMonth < first) first = s.firstMonth;
  return first < "2019-01" ? "2019-01" : first;
}
