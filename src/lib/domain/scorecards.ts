/**
 * District and forest-reserve scorecards: what GhanaWatch's live detections,
 * NASA fire records, Global Forest Watch forest loss and approved citizen
 * reports say about each district, and how districts rank.
 *
 * "Likely mining" counts only what looks like galamsey with at least medium
 * confidence: cleared land with new water-filled pits, clusters of new pits
 * (Sentinel-2), and new ponds of 2 ha or more seen by radar through cloud.
 * Bare cleared land without pits is shown apart, because farms, roads and
 * building sites look the same. Detections inside a named large-scale mine
 * (Gold Fields Tarkwa, Newmont's pits…) are the mine's own work and are
 * counted apart too.
 */
import type { Severity } from "./types";

export type ScoreKind = "mining" | "possible" | "cleared" | "radar" | "muddy" | "fire" | "flood" | "other";

export interface ScoreEventRow {
  districtId: string | null;
  type: string;
  methodVersion: string;
  signature: string | null;
  confidence: string;
  severity: Severity;
  areaHa: number;
  reserve: string | null;
  mine: string | null;
  nearPeople: boolean;
  detectedAt: Date;
  firstSeen: Date;
}

/** Which scorecard line a detection belongs to, and whether it counts as likely mining. */
export function scoreKind(e: Pick<ScoreEventRow, "type" | "methodVersion" | "signature" | "confidence">): { kind: ScoreKind; likely: boolean } {
  if (e.type === "fire") return { kind: "fire", likely: false };
  if (e.type === "flood_risk") return { kind: "flood", likely: false };
  if (e.methodVersion.startsWith("s1-water")) return { kind: "radar", likely: e.confidence !== "low" };
  if (e.methodVersion.startsWith("s2-galamsey")) {
    if (e.type === "water_change" || e.signature === "turbid_water") return { kind: "muddy", likely: false };
    if (e.signature === "cleared") return { kind: "cleared", likely: false };
    if (e.signature === "cleared_with_pits" || e.signature === "new_pits" || e.signature === "mining") return e.confidence === "low" ? { kind: "possible", likely: false } : { kind: "mining", likely: true };
  }
  return { kind: "other", likely: false };
}

export interface DistrictInfo {
  id: string;
  name: string;
  region: string | null;
  areaKm2: number | null;
}

export interface DistrictCard extends DistrictInfo {
  slug: string;
  /** Likely mining, outside named large-scale mines. */
  miningHa: number;
  miningSites: number;
  /** Of which seen by radar through cloud. */
  radarHa: number;
  radarSites: number;
  /** Pits or ponds with low confidence (often flooded fields in the north). */
  possibleHa: number;
  /** Bare cleared land without pits (could be farms or building). */
  clearedHa: number;
  clearedSites: number;
  /** Inside named large-scale mines and quarries. */
  inMinesHa: number;
  muddyRivers: number;
  muddyRiversHa: number;
  /** Likely mining or cleared land inside forest reserves and other protected areas. */
  inReservesHa: number;
  reserves: string[];
  /** Likely mining or cleared land inside a residential area or within 300 m of a school, clinic or cemetery. */
  nearPeople: number;
  urgent: number;
  /** Likely mining first detected in the current calendar month. */
  newThisMonthHa: number;
  fires7d: number;
  /** Average for the same seven days of the year, 2020–2025; null when the archive is not loaded. */
  firesUsual7d: number | null;
  floodAlerts: number;
  reports: number;
  reportsConfirmed: number;
  /** 1 = most likely mining; null when none was found. */
  rank: number | null;
}

export interface CardInputs {
  districts: DistrictInfo[];
  events: ScoreEventRow[];
  fires7d: Map<string, number>;
  firesUsual7d: Map<string, number> | null;
  reports: Map<string, { approved: number; confirmed: number }>;
  now: Date;
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function buildDistrictCards(input: CardInputs): DistrictCard[] {
  const monthStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));
  const cards = new Map<string, DistrictCard>();
  const reserves = new Map<string, Set<string>>();
  for (const d of input.districts) {
    const rep = input.reports.get(d.id);
    cards.set(d.id, {
      ...d,
      slug: slugify(d.name),
      miningHa: 0,
      miningSites: 0,
      radarHa: 0,
      radarSites: 0,
      possibleHa: 0,
      clearedHa: 0,
      clearedSites: 0,
      inMinesHa: 0,
      muddyRivers: 0,
      muddyRiversHa: 0,
      inReservesHa: 0,
      reserves: [],
      nearPeople: 0,
      urgent: 0,
      newThisMonthHa: 0,
      fires7d: input.fires7d.get(d.id) ?? 0,
      firesUsual7d: input.firesUsual7d ? round1(input.firesUsual7d.get(d.id) ?? 0) : null,
      floodAlerts: 0,
      reports: rep?.approved ?? 0,
      reportsConfirmed: rep?.confirmed ?? 0,
      rank: null,
    });
    reserves.set(d.id, new Set());
  }
  const weekAgo = input.now.getTime() - 7 * 86_400_000;
  for (const e of input.events) {
    const c = e.districtId ? cards.get(e.districtId) : undefined;
    if (!c) continue;
    const { kind, likely } = scoreKind(e);
    const land = kind === "mining" || kind === "radar" || kind === "possible" || kind === "cleared";
    if (land && e.mine) {
      c.inMinesHa += e.areaHa;
      continue;
    }
    if (likely) {
      c.miningHa += e.areaHa;
      c.miningSites++;
      if (kind === "radar") {
        c.radarHa += e.areaHa;
        c.radarSites++;
      }
      if (e.firstSeen >= monthStart) c.newThisMonthHa += e.areaHa;
      if (e.severity === "urgent") c.urgent++;
    } else if (kind === "possible" || kind === "radar") c.possibleHa += e.areaHa;
    else if (kind === "cleared") {
      c.clearedHa += e.areaHa;
      c.clearedSites++;
    } else if (kind === "muddy") {
      c.muddyRivers++;
      c.muddyRiversHa += e.areaHa;
    } else if (kind === "flood" && e.detectedAt.getTime() >= weekAgo) c.floodAlerts++;
    if ((likely || kind === "cleared") && e.reserve) {
      c.inReservesHa += e.areaHa;
      reserves.get(c.id)!.add(e.reserve);
    }
    if ((likely || kind === "cleared") && e.nearPeople) c.nearPeople++;
  }
  const out = [...cards.values()].map((c) => ({
    ...c,
    miningHa: round1(c.miningHa),
    radarHa: round1(c.radarHa),
    possibleHa: round1(c.possibleHa),
    clearedHa: round1(c.clearedHa),
    inMinesHa: round1(c.inMinesHa),
    muddyRiversHa: round1(c.muddyRiversHa),
    inReservesHa: round1(c.inReservesHa),
    newThisMonthHa: round1(c.newThisMonthHa),
    reserves: [...reserves.get(c.id)!].sort(),
  }));
  const ranked = out.filter((c) => c.miningHa > 0).sort((a, b) => b.miningHa - a.miningHa || b.miningSites - a.miningSites || a.name.localeCompare(b.name));
  ranked.forEach((c, i) => (c.rank = i + 1));
  return out.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
}

/** Share of the district's land, in percent, rounded for display (null when the area is unknown). */
export function shareOfArea(ha: number, areaKm2: number | null): number | null {
  if (!areaKm2) return null;
  return Math.round((ha / (areaKm2 * 100)) * 10_000) / 100;
}

export interface ReserveCard {
  name: string;
  slug: string;
  miningHa: number;
  miningSites: number;
  clearedHa: number;
  districts: string[];
  nearPeople: number;
}

export function buildReserveCards(events: ScoreEventRow[], districtNames: Map<string, string>): ReserveCard[] {
  const by = new Map<string, ReserveCard & { _d: Set<string> }>();
  for (const e of events) {
    if (!e.reserve || e.mine) continue;
    const { kind, likely } = scoreKind(e);
    if (!likely && kind !== "cleared") continue;
    let r = by.get(e.reserve);
    if (!r) {
      r = { name: e.reserve, slug: slugify(e.reserve), miningHa: 0, miningSites: 0, clearedHa: 0, districts: [], nearPeople: 0, _d: new Set() };
      by.set(e.reserve, r);
    }
    if (likely) {
      r.miningHa += e.areaHa;
      r.miningSites++;
    } else r.clearedHa += e.areaHa;
    if (e.nearPeople) r.nearPeople++;
    if (e.districtId && districtNames.has(e.districtId)) r._d.add(districtNames.get(e.districtId)!);
  }
  return [...by.values()]
    .map(({ _d, ...r }) => ({ ...r, miningHa: round1(r.miningHa), clearedHa: round1(r.clearedHa), districts: [..._d].sort() }))
    .sort((a, b) => b.miningHa + b.clearedHa - (a.miningHa + a.clearedHa));
}
