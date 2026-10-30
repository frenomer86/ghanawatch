/**
 * One site, many sightings. The live scan and the historical scan both name a detection by its rounded
 * centre, and a growing pit moves its centre, so the same ground can carry several ids over the months.
 * This joins sightings into sites: a sighting within about 200 m of an earlier one belongs to that site.
 * A site's first month is the earliest sighting; its last month the latest; its area the largest drawn.
 *
 * Pure and unit-tested. The order of the input does not matter.
 */
export interface Sighting {
  id: string;
  /** YYYY-MM the sighting counts in. */
  month: string;
  lon: number;
  lat: number;
  areaHa: number;
  districtId: string | null;
  likely: boolean;
  inReserve: boolean;
  /** Name of the forest reserve or protected area the sighting lies in. */
  reserve: string | null;
  inRiverBuffer: boolean;
  legality: "licensed" | "unlicensed" | "unknown";
  /** Inside a named large-scale mine: never galamsey. */
  inMine: boolean;
  /**
   * Set by the multi-sensor detector (s2-galamsey-3.0): this row is the area the site added in its month
   * (newly confirmed pixels), not the site's whole outline, so it adds to the site instead of being folded
   * into it.
   */
  addsArea?: boolean;
  /** The detector's own id for the site; rows with the same key are one site wherever their centres fall. */
  siteKey?: string | null;
}

export interface Site {
  id: string;
  firstMonth: string;
  lastMonth: string;
  lon: number;
  lat: number;
  /** Area when first seen: the figure the site contributes to its first month, never revised. */
  areaHa: number;
  /** Largest area seen since: how far the site has grown. */
  maxAreaHa: number;
  districtId: string | null;
  likely: boolean;
  inReserve: boolean;
  reserve: string | null;
  inRiverBuffer: boolean;
  legality: Sighting["legality"];
  inMine: boolean;
  sightings: number;
  /** Every sighting id folded into this site, for traceability. */
  members: string[];
  /** Area added per month (YYYY-MM -> ha), for sites from the multi-sensor detector. */
  additions?: Record<string, number>;
}

/** The hectares a site contributes to a month: its additions that month, or its first-seen area in its first month. */
export function newAreaIn(site: Site, month: string): number {
  if (site.additions) return site.additions[month] ?? 0;
  return site.firstMonth === month ? site.areaHa : 0;
}

/** About 200 m at Ghana's latitudes. */
export const SAME_SITE_DEG = 0.0018;
const CELL = 0.002;

export function assignSites(sightings: Sighting[]): Site[] {
  const ordered = [...sightings].sort((a, b) => a.month.localeCompare(b.month) || a.id.localeCompare(b.id));
  const grid = new Map<string, Site[]>();
  const sites: Site[] = [];
  const byKey = new Map<string, Site>();
  const key = (lon: number, lat: number) => `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;
  for (const s of ordered) {
    let best: Site | null = s.siteKey ? (byKey.get(s.siteKey) ?? null) : null;
    const keyed = best !== null;
    let bestD = keyed ? 0 : Infinity;
    const cx = Math.floor(s.lon / CELL);
    const cy = Math.floor(s.lat / CELL);
    for (let x = cx - 1; !keyed && x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const site of grid.get(`${x}:${y}`) ?? []) {
          const d = Math.hypot(site.lon - s.lon, site.lat - s.lat);
          if (d <= SAME_SITE_DEG && d < bestD) {
            best = site;
            bestD = d;
          }
        }
      }
    }
    if (best && Boolean(best.additions) !== Boolean(s.addsArea)) best = null; // never mix the two kinds of rows
    if (best) {
      if (s.addsArea) best.additions![s.month] = (best.additions![s.month] ?? 0) + s.areaHa;
      if (s.month < best.firstMonth) best.firstMonth = s.month;
      best.lastMonth = s.month > best.lastMonth ? s.month : best.lastMonth;
      if (s.month === best.firstMonth) best.areaHa = Math.max(best.areaHa, s.areaHa);
      best.maxAreaHa = Math.max(best.maxAreaHa, s.areaHa);
      best.likely = best.likely || s.likely;
      best.inReserve = best.inReserve || s.inReserve;
      best.reserve = best.reserve ?? s.reserve;
      best.inRiverBuffer = best.inRiverBuffer || s.inRiverBuffer;
      best.inMine = best.inMine || s.inMine;
      if (best.legality === "unknown") best.legality = s.legality;
      if (!best.districtId) best.districtId = s.districtId;
      best.sightings++;
      best.members.push(s.id);
      continue;
    }
    const site: Site = {
      id: s.id,
      firstMonth: s.month,
      lastMonth: s.month,
      lon: s.lon,
      lat: s.lat,
      areaHa: s.areaHa,
      maxAreaHa: s.areaHa,
      districtId: s.districtId,
      likely: s.likely,
      inReserve: s.inReserve,
      reserve: s.reserve,
      inRiverBuffer: s.inRiverBuffer,
      legality: s.legality,
      inMine: s.inMine,
      sightings: 1,
      members: [s.id],
      ...(s.addsArea ? { additions: { [s.month]: s.areaHa } } : {}),
    };
    sites.push(site);
    if (s.siteKey) byKey.set(s.siteKey, site);
    const k = key(s.lon, s.lat);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(site);
  }
  return sites;
}
