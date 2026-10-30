import { sql } from "drizzle-orm";
import type { Geometry } from "geojson";
import { getDb, rows as toRows } from "@/lib/db/client";
import { INDEX_VERSION, monthLabel } from "@/lib/domain/index";
import { newAreaIn } from "@/lib/domain/sites";
import { slugify } from "@/lib/domain/scorecards";
import { loadSites } from "@/lib/server/index/sightings";
import { districtSeries, nationalMonth, nationalSeries, rankings, type DistrictMonth, type NationalMonth } from "@/lib/server/index/read";
import { riverScores, type RiverScore } from "@/lib/server/rivers/score";

/**
 * Everything one monthly release is made of, read once from the frozen index and the detections, so the
 * CSV files, the PDF, the press release and the cards all say the same numbers.
 */
export interface ReleaseSite {
  id: string;
  firstMonth: string;
  districtId: string | null;
  districtName: string | null;
  /** Hectares this site adds to the month's index: all of it when new, its spread otherwise. */
  areaHa: number;
  /** Whether the site was first seen this month (false: an existing site that spread). */
  newSite: boolean;
  lon: number;
  lat: number;
  reserve: string | null;
  onRiver: boolean;
  legality: string;
  /** The live detection carrying the before/after imagery, when the site has one. */
  eventId: string | null;
  title: string | null;
  imageDate: string | null;
  geom: Geometry | null;
}

export interface ReserveLoss {
  name: string;
  slug: string;
  newHa: number;
  sites: number;
  districts: string[];
}

export interface ReleaseData {
  month: string;
  label: string;
  version: string;
  /** True when the index counts the multi-sensor record (area newly confirmed each month, new and spreading
   *  sites); false while it still falls back to the two-date scan (area of sites first seen in the month). */
  multisensor: boolean;
  national: NationalMonth;
  series: NationalMonth[];
  rankings: DistrictMonth[];
  /** The ten worst this month, by index. */
  top: DistrictMonth[];
  sites: ReleaseSite[];
  /** Up to six sites with the clearest before/after pictures, largest first. */
  featured: ReleaseSite[];
  reserves: ReserveLoss[];
  rivers: RiverScore[];
  worstRiver: RiverScore | null;
  topDistrictSeries: DistrictMonth[];
}

export async function releaseData(month: string): Promise<ReleaseData> {
  const national = await nationalMonth(month);
  if (!national) throw new Error(`${month} is not closed; run the index close first`);
  const [series, ranks, rivers, loaded] = await Promise.all([nationalSeries(), rankings(month), riverScores(month), loadSites()]);
  const db = await getDb();
  const names = new Map(loaded.districts.map((d) => [d.id, d.name]));
  // Every site that adds hectares to the month: new sites, and (multi-sensor record) existing sites that spread.
  const monthSites = loaded.sites.filter((s) => s.likely && !s.inMine && newAreaIn(s, month) > 0);
  // The live detection of each site, for its title and pictures: by event id (two-date scan sightings) or by the
  // multi-sensor site key (its history rows are not detections).
  const memberIds = monthSites.flatMap((s) => s.members);
  const siteKeys = monthSites.flatMap((s) => s.keys ?? []);
  type LiveRow = { id: string; key: string; title: string; image_date: string; geom: Geometry | null };
  const live = new Map<string, LiveRow>();
  const byKey = new Map<string, LiveRow>();
  for (let i = 0; i < memberIds.length; i += 500) {
    for (const r of toRows<LiveRow>(
      await db.execute(sql`select id::text, source_event_id as key, title_en as title, image_date::text, geom from change_events where id::text in (select jsonb_array_elements_text(${JSON.stringify(memberIds.slice(i, i + 500))}::text::jsonb))`),
    ))
      live.set(r.id, r);
  }
  for (let i = 0; i < siteKeys.length; i += 500) {
    for (const r of toRows<LiveRow>(
      await db.execute(sql`select id::text, source_event_id as key, title_en as title, image_date::text, geom from change_events
        where method_version like 's2-galamsey-3.%' and status <> 'dismissed'
          and source_event_id in (select jsonb_array_elements_text(${JSON.stringify(siteKeys.slice(i, i + 500))}::text::jsonb))`),
    ))
      byKey.set(r.key, r);
  }
  const sites: ReleaseSite[] = monthSites.map((s) => {
    const ev = s.members.map((m) => live.get(m)).find((x) => x) ?? (s.keys ?? []).map((k) => byKey.get(k)).find((x) => x);
    return {
      id: s.id,
      firstMonth: s.firstMonth,
      districtId: s.districtId,
      districtName: s.districtId ? (names.get(s.districtId) ?? null) : null,
      areaHa: Math.round(newAreaIn(s, month) * 100) / 100,
      newSite: s.firstMonth === month,
      lon: s.lon,
      lat: s.lat,
      reserve: s.reserve,
      onRiver: s.inRiverBuffer,
      legality: s.legality,
      eventId: ev?.id ?? null,
      title: ev?.title ?? null,
      imageDate: ev?.image_date ?? null,
      geom: ev?.geom ?? null,
    };
  });
  const featured = sites.filter((s) => s.eventId && s.newSite).sort((a, b) => b.areaHa - a.areaHa).slice(0, 6);
  const reservesMap = new Map<string, ReserveLoss & { _d: Set<string> }>();
  for (const s of sites) {
    if (!s.reserve) continue;
    const r = reservesMap.get(s.reserve) ?? { name: s.reserve, slug: slugify(s.reserve), newHa: 0, sites: 0, districts: [], _d: new Set<string>() };
    r.newHa = Math.round((r.newHa + s.areaHa) * 10) / 10;
    r.sites++;
    if (s.districtName) r._d.add(s.districtName);
    reservesMap.set(s.reserve, r);
  }
  const reserves = [...reservesMap.values()].map(({ _d, ...r }) => ({ ...r, districts: [..._d].sort() })).sort((a, b) => b.newHa - a.newHa);
  const top = ranks.filter((r) => r.rank != null).slice(0, 10);
  return {
    month,
    label: monthLabel(month),
    version: INDEX_VERSION,
    multisensor: !loaded.legacyFallback,
    national,
    series,
    rankings: ranks,
    top,
    sites,
    featured,
    reserves,
    rivers,
    worstRiver: rivers.find((r) => r.mapped && r.kmDiscoloured > 0) ?? null,
    topDistrictSeries: top[0] ? await districtSeries(top[0].districtId) : [],
  };
}
