import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseData } from "./data";

/**
 * The open-data files of a release, CC BY 4.0: the index per district, the district outlines with their
 * figures, the sites first seen in the month, the rivers and the reserves. Every file names the month,
 * so a figure quoted from the site can be found again.
 */
export const csvEscape = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  // A text cell starting with = + - @ or a tab would run as a formula when the CSV is opened in a
  // spreadsheet; a leading apostrophe keeps it text. Numbers are written as numbers.
  const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const row = (vals: unknown[]) => vals.map(csvEscape).join(",");

export function indexCsv(d: ReleaseData): string {
  const head = ["month", "index_version", "district", "region", "area_km2", "rank", "index_new_ha_per_100km2", "new_ha", "ci_low_ha", "ci_high_ha", "cumulative_ha", "new_sites", "active_sites", "pct_in_forest_reserves", "pct_on_rivers", "pct_unlicensed"];
  const lines = d.rankings.map((r) =>
    row([r.month, d.version, r.name, r.region, r.areaKm2, r.rank, r.index, r.newHa, r.ciLow, r.ciHigh, r.cumHa, r.newSites, r.activeSites, r.pctForest, r.pctRiver, r.pctUnlicensed]),
  );
  return [row(head), ...lines].join("\n") + "\n";
}

export function nationalCsv(d: ReleaseData): string {
  const head = ["month", "index_version", "new_ha", "ci_low_ha", "ci_high_ha", "cumulative_ha", "new_sites", "districts_affected", "top_district", "in_forest_reserves_ha"];
  return [row(head), ...d.series.map((n) => row([n.month, d.version, n.newHa, n.ciLow, n.ciHigh, n.cumHa, n.newSites, n.districtsAffected, n.topDistrict?.name ?? "", n.inReservesHa]))].join("\n") + "\n";
}

export function sitesGeoJson(d: ReleaseData, origin: string): string {
  return JSON.stringify(
    {
      type: "FeatureCollection",
      name: d.multisensor ? `GhanaWatch galamsey newly confirmed in ${d.month} (new sites and spread)` : `GhanaWatch likely galamsey first seen in ${d.month}`,
      licence: "CC BY 4.0",
      attribution: "GhanaWatch, KNUST. Contains modified Copernicus Sentinel data.",
      features: d.sites.map((s) => ({
        type: "Feature",
        geometry: s.geom ?? { type: "Point", coordinates: [s.lon, s.lat] },
        properties: {
          site_id: s.id,
          first_month: s.firstMonth,
          new_site: s.newSite,
          district: s.districtName,
          area_ha: s.areaHa,
          forest_reserve: s.reserve,
          on_river: s.onRiver,
          legality: s.legality,
          evidence_url: s.eventId ? `${origin}/event/${s.eventId}` : null,
          image_date: s.imageDate,
        },
      })),
    },
    null,
    0,
  );
}

export function districtsGeoJson(d: ReleaseData, outlines: Map<string, unknown>): string {
  return JSON.stringify({
    type: "FeatureCollection",
    name: `GhanaWatch Galamsey Index ${d.month}`,
    licence: "CC BY 4.0 (figures); boundaries geoBoundaries CC BY 4.0",
    features: d.rankings.map((r) => ({
      type: "Feature",
      geometry: outlines.get(r.districtId) ?? null,
      properties: { district: r.name, region: r.region, month: r.month, rank: r.rank, index: r.index, new_ha: r.newHa, cumulative_ha: r.cumHa, ci_low: r.ciLow, ci_high: r.ciHigh, new_sites: r.newSites },
    })),
  });
}

export function riversCsv(d: ReleaseData): string {
  const head = ["month", "river", "mapped", "length_km", "km_discoloured", "km_heavily_discoloured", "muddy_sites", "dredger_radar_targets", "intakes"];
  return [row(head), ...d.rivers.map((r) => row([d.month, r.river, r.mapped, r.lengthKm, r.kmDiscoloured, r.kmHeavy, r.muddySites, r.dredgerTargets, r.intakes.map((i) => i.name).join("; ")]))].join("\n") + "\n";
}

export function reservesCsv(d: ReleaseData): string {
  const head = ["month", "forest_reserve", "new_ha", "new_sites", "districts"];
  return [row(head), ...d.reserves.map((r) => row([d.month, r.name, r.newHa, r.sites, r.districts.join("; ")]))].join("\n") + "\n";
}

export interface WrittenFile {
  name: string;
  bytes: number;
  sha256: string;
}

export function writeFile(dir: string, name: string, content: string | Buffer): WrittenFile {
  mkdirSync(dir, { recursive: true });
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  writeFileSync(join(dir, name), buf);
  return { name, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}
