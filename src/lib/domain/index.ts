/**
 * The Galamsey Index.
 *
 * For every district and month: the hectares of land first seen as likely galamsey in that month (new_ha),
 * the running total since the start of the series (cum_ha), and the index itself, new_ha per 100 km² of
 * the district, which makes a small district and a large one comparable. Districts rank by the index;
 * rank 1 is the worst month. Sites inside named large-scale mines are left out everywhere.
 *
 * Pure functions over sites (see sites.ts); unit-tested; the database never appears here. The method is
 * versioned: a closed month is never changed under the same version.
 */
import { adjustedArea, type RateSample } from "./uncertainty";
import { newAreaIn, type Site } from "./sites";

/**
 * 2.0: sites from the multi-sensor detector (s2-galamsey-3.0) add the area they grew each month, so a pit
 * that spreads counts in the months it spread; 1.0 counted a site's first outline only.
 */
export const INDEX_VERSION = "2.0";

export interface IndexDistrict {
  id: string;
  name: string;
  region: string | null;
  areaKm2: number | null;
}

export interface DistrictMonthRow {
  districtId: string;
  month: string;
  newHa: number;
  cumHa: number;
  index: number;
  rank: number | null;
  newSites: number;
  activeSites: number;
  pctForest: number | null;
  pctRiver: number | null;
  pctUnlicensed: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

export interface NationalMonthRow {
  month: string;
  newHa: number;
  cumHa: number;
  ciLow: number | null;
  ciHigh: number | null;
  newSites: number;
  districtsAffected: number;
  topDistrictId: string | null;
  inReservesHa: number;
}

export interface IndexOptions {
  /** Share of drawn sites that were real, from the latest whole-of-Ghana check. */
  precision?: RateSample | null;
  /** Share of real sites the scan drew, from the blind squares. */
  detection?: RateSample | null;
  /** True when the legality of sites is known (a cadastre is loaded); otherwise pct_unlicensed is withheld. */
  legalityKnown?: boolean;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** YYYY-MM for each month from `from` to `to` inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m++) {
    if (m > 12) {
      m = 1;
      y++;
      if (y > ty) break;
    }
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

export function monthOf(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function buildIndex(sites: Site[], districts: IndexDistrict[], months: string[], opts: IndexOptions = {}): { districts: DistrictMonthRow[]; national: NationalMonthRow[] } {
  const counted = sites.filter((s) => s.likely && !s.inMine && s.districtId);
  const byDistrict = new Map<string, IndexDistrict>(districts.map((d) => [d.id, d]));
  const sitesOf = new Map<string, Site[]>();
  for (const s of counted) {
    const list = sitesOf.get(s.districtId!);
    if (list) list.push(s);
    else sitesOf.set(s.districtId!, [s]);
  }
  const cum = new Map<string, number>();
  const out: DistrictMonthRow[] = [];
  const national: NationalMonthRow[] = [];
  let nationalCum = 0;

  for (const month of months) {
    const rowsThisMonth: DistrictMonthRow[] = [];
    for (const d of districts) {
      const own = sitesOf.get(d.id) ?? [];
      const fresh = own.filter((s) => newAreaIn(s, month) > 0);
      const active = own.filter((s) => s.firstMonth <= month && s.lastMonth >= month).length;
      const add = (list: Site[]) => list.reduce((a, s) => a + newAreaIn(s, month), 0);
      const newHa = round1(add(fresh));
      const forest = add(fresh.filter((s) => s.inReserve));
      const river = add(fresh.filter((s) => s.inRiverBuffer));
      const unlicensed = add(fresh.filter((s) => s.legality === "unlicensed"));
      const c = round1((cum.get(d.id) ?? 0) + newHa);
      cum.set(d.id, c);
      const index = d.areaKm2 && d.areaKm2 > 0 ? round2(newHa / (d.areaKm2 / 100)) : 0;
      const est = opts.precision ? adjustedArea(newHa, opts.precision, opts.detection) : null;
      rowsThisMonth.push({
        districtId: d.id,
        month,
        newHa,
        cumHa: c,
        index,
        rank: null,
        newSites: own.filter((s) => s.firstMonth === month).length,
        activeSites: active,
        pctForest: newHa > 0 ? round1((forest / newHa) * 100) : null,
        pctRiver: newHa > 0 ? round1((river / newHa) * 100) : null,
        pctUnlicensed: newHa > 0 && opts.legalityKnown ? round1((unlicensed / newHa) * 100) : null,
        ciLow: est ? est.low : null,
        ciHigh: est ? est.high : null,
      });
    }
    const ranked = rowsThisMonth.filter((r) => r.newHa > 0).sort((a, b) => b.index - a.index || b.newHa - a.newHa || (byDistrict.get(a.districtId)?.name ?? "").localeCompare(byDistrict.get(b.districtId)?.name ?? ""));
    ranked.forEach((r, i) => (r.rank = i + 1));
    out.push(...rowsThisMonth);

    const monthSites = counted.filter((s) => newAreaIn(s, month) > 0);
    const newHa = round1(monthSites.reduce((a, s) => a + newAreaIn(s, month), 0));
    nationalCum = round1(nationalCum + newHa);
    const est = opts.precision ? adjustedArea(newHa, opts.precision, opts.detection) : null;
    national.push({
      month,
      newHa,
      cumHa: nationalCum,
      ciLow: est ? est.low : null,
      ciHigh: est ? est.high : null,
      newSites: counted.filter((s) => s.firstMonth === month).length,
      districtsAffected: ranked.length,
      topDistrictId: ranked[0]?.districtId ?? null,
      inReservesHa: round1(monthSites.filter((s) => s.inReserve).reduce((a, s) => a + newAreaIn(s, month), 0)),
    });
  }
  return { districts: out, national };
}

/** Plain-language movement of a district between two months, for cards and pages. */
export function rankMovement(now: number | null, before: number | null): { arrow: "up" | "down" | "same" | "new" | "none"; text: string } {
  if (now == null) return { arrow: "none", text: "no new mining" };
  if (before == null) return { arrow: "new", text: "newly ranked" };
  if (now < before) return { arrow: "up", text: `worse: up from ${before}` };
  if (now > before) return { arrow: "down", text: `better: down from ${before}` };
  return { arrow: "same", text: "unchanged" };
}
