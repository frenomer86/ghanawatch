import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "@/lib/db/client";
import { loadDistrictInfo, loadEvents } from "@/lib/db/repo/scorecards";
import { buildDistrictCards, buildReserveCards, type DistrictCard, type ReserveCard } from "@/lib/domain/scorecards";
import { TtlCache } from "@/lib/server/explore/cache";

/**
 * "State of Ghana's Environment": one month of GhanaWatch, from what was first
 * detected that month. The first month of the national scan includes changes
 * from the previous 120 days, which the report says.
 */
export interface MonthlyReport {
  month: string;
  label: string;
  generatedAt: string;
  /** The month is still running. */
  partial: boolean;
  /** GhanaWatch's first scanned month: everything was first seen in it. */
  firstMonth: boolean;
  national: {
    miningHa: number;
    miningSites: number;
    radarHa: number;
    inReservesHa: number;
    reservesAffected: number;
    nearPeople: number;
    muddyRivers: number;
    districtsWithMining: number;
    fires: number;
    /** First day fires are counted from, when the live feed started during the month. */
    firesSince: string | null;
    firesUsual: number | null;
    floodAlerts: number;
    reports: number;
  };
  topDistricts: DistrictCard[];
  topReserves: ReserveCard[];
  regions: Array<{ region: string; miningHa: number; sites: number; districts: number }>;
}

export const MONTH_RE = /^(20\d\d)-(0[1-9]|1[0-2])$/;

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

const cache = new TtlCache<MonthlyReport>(12, 10 * 60_000);

/** Months with detections, newest first. */
export async function availableMonths(now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const [r] = toRows<{ first: string | null }>(await db.execute(sql`select min(created_at)::text as first from change_events where status <> 'dismissed'`));
  if (!r?.first) return [];
  const first = new Date(r.first);
  const out: string[] = [];
  for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d >= new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d.setUTCMonth(d.getUTCMonth() - 1)) {
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function monthlyReport(month: string, now: Date = new Date()): Promise<MonthlyReport> {
  return cache.get(month, () => build(month, now));
}

async function build(month: string, now: Date): Promise<MonthlyReport> {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const db = await getDb();
  const [districts, events, months] = await Promise.all([loadDistrictInfo(), loadEvents(), availableMonths(now)]);
  const inMonth = events.filter((e) => e.firstSeen >= start && e.firstSeen < end);
  // Fires and floods are counted by when they happened, the rest by when GhanaWatch first saw them.
  const happened = events.filter((e) => (e.type === "fire" || e.type === "flood_risk") && e.detectedAt >= start && e.detectedAt < end);
  const monthEvents = [...inMonth.filter((e) => e.type !== "fire" && e.type !== "flood_risk"), ...happened];
  const cards = buildDistrictCards({ districts, events: monthEvents, fires7d: new Map(), firesUsual7d: null, reports: new Map(), now: end });
  const reserves = buildReserveCards(monthEvents, new Map(districts.map((d) => [d.id, d.name])));

  const firesLive = happened.filter((e) => e.type === "fire");
  const firstLive = firesLive.reduce<Date | null>((a, e) => (!a || e.detectedAt < a ? e.detectedAt : a), null);
  const fromArchive = y <= 2025;
  let fires = firesLive.length;
  if (fromArchive) {
    const [r] = toRows<{ n: number }>(await db.execute(sql`select count(*)::int as n from fire_points where acq_date >= ${start.toISOString().slice(0, 10)} and acq_date < ${end.toISOString().slice(0, 10)}`));
    fires = Number(r?.n ?? 0);
  }
  const usual = toRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::float / 6 as n from fire_points
      where acq_date >= '2020-01-01' and acq_date < '2026-01-01' and extract(month from acq_date) = ${m}`),
  );
  const [rep] = toRows<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from community_reports where status = 'approved' and created_at >= ${start.toISOString()} and created_at < ${end.toISOString()}`),
  );
  const top = cards.filter((c) => c.miningHa > 0).sort((a, b) => b.miningHa - a.miningHa);
  const byRegion = new Map<string, { region: string; miningHa: number; sites: number; districts: number }>();
  for (const c of top) {
    const k = c.region ?? "Other";
    const r = byRegion.get(k) ?? { region: k, miningHa: 0, sites: 0, districts: 0 };
    r.miningHa += c.miningHa;
    r.sites += c.miningSites;
    r.districts++;
    byRegion.set(k, r);
  }
  const sum = (f: (c: DistrictCard) => number) => Math.round(cards.reduce((s, c) => s + f(c), 0) * 10) / 10;
  const usualFires = Number(usual[0]?.n ?? 0);
  return {
    month,
    label: monthLabel(month),
    generatedAt: now.toISOString(),
    partial: now < end,
    firstMonth: months.length > 0 && months[months.length - 1] === month,
    national: {
      miningHa: sum((c) => c.miningHa),
      miningSites: sum((c) => c.miningSites),
      radarHa: sum((c) => c.radarHa),
      inReservesHa: sum((c) => c.inReservesHa),
      reservesAffected: reserves.length,
      nearPeople: sum((c) => c.nearPeople),
      muddyRivers: sum((c) => c.muddyRivers),
      districtsWithMining: top.length,
      fires,
      firesSince: !fromArchive && firstLive && firstLive > new Date(start.getTime() + 86_400_000) ? firstLive.toISOString().slice(0, 10) : null,
      firesUsual: usualFires > 0 ? Math.round(usualFires) : null,
      floodAlerts: happened.filter((e) => e.type === "flood_risk").length,
      reports: Number(rep?.n ?? 0),
    },
    topDistricts: top.slice(0, 10),
    topReserves: reserves.slice(0, 5),
    regions: [...byRegion.values()].map((r) => ({ ...r, miningHa: Math.round(r.miningHa * 10) / 10 })).sort((a, b) => b.miningHa - a.miningHa),
  };
}
