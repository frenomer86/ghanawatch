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
  source_event_id?: string | null;
  cohort?: string | null;
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
 * Every sighting the index can count.
 *
 * Index 2.0 counts the multi-sensor detector (s2-galamsey-3.0) only: its history rows, one per site per
 * month in which the site grew, each carrying the area added that month. The live detections of that
 * method are not read here, since every finished month is already in the history rows.
 *
 * Until that detector's backfill has written history rows, the earlier sightings are used as before (the
 * two-date scan's history plus live detections, counted in the month first seen) and `legacyFallback` is
 * set, so a release can say so.
 */
export async function loadSites(): Promise<{ sites: Site[]; districts: IndexDistrict[]; legalityKnown: boolean; rivers: RiverIndex; legacyFallback: boolean }> {
  const db = await getDb();
  const districts = await loadDistrictInfo();
  const rivers = await loadRiverIndex();
  const cols = sql`id::text, source_event_id, properties->>'cohort' cohort, centroid_lon::float lon, centroid_lat::float lat, area_ha::float ha, district_id::text,
        type, method_version, properties->>'signature' sig, confidence,
        properties->'placement'->>'protectedArea' reserve, properties->'placement'->>'mine' mine,
        properties->>'licensedMine' licensed, properties->>'licence' licence`;
  const multisensor = toRows<Row>(
    await db.execute(sql`select scan_month as month, ${cols} from history_events h
      where centroid_lon is not null and method_version like 's2-galamsey-3.%' and properties->>'cohort' = 'true'
        -- A site a person rejected (moderation or the monthly confirmation sample) leaves the index; a site that
        -- simply grew back or was replaced by a newer outline keeps the months it was mined.
        and not exists (
          select 1 from change_events e
          where e.method_version like 's2-galamsey-3.%' and e.source_event_id = h.source_event_id and e.status = 'dismissed'
            and not (e.properties ? 'supersededBy') and coalesce(e.properties->>'autoDismissed', '') not like 'no longer mined%')`),
  );
  const legacyFallback = multisensor.length === 0;
  const history = legacyFallback
    ? toRows<Row>(await db.execute(sql`select scan_month as month, ${cols} from history_events where centroid_lon is not null and method_version not like 's2-galamsey-3.%'`))
    : multisensor;
  const live = legacyFallback
    ? toRows<Row>(
        await db.execute(sql`
      select to_char(coalesce(first_image_date, image_date), 'YYYY-MM') as month, ${cols}
      from change_events
      where status <> 'dismissed' and centroid_lon is not null
        and ((method_version like 's2-galamsey-%' and method_version not like 's2-galamsey-3.%') or method_version like 's1-water-%')`),
      )
    : [];
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
      ...(r.cohort === "true" ? { addsArea: true, siteKey: r.source_event_id ?? null } : {}),
    };
  };
  const sightings = [...history, ...live].filter((r) => /^20\d\d-\d\d$/.test(r.month)).map(toSighting);
  return { sites: assignSites(sightings), districts, legalityKnown, rivers, legacyFallback };
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
