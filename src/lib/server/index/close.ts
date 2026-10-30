import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "@/lib/db/client";
import { districtMonths, nationalMonths } from "@/lib/db/schema";
import { buildIndex, INDEX_VERSION, monthOf, monthsBetween } from "@/lib/domain/index";
import type { RateSample } from "@/lib/domain/uncertainty";
import { loadSites, seriesStart } from "./sightings";
import { clearIndexCache } from "./read";

/**
 * Closing a month freezes the index for it and every earlier month of the series that is still open.
 * Live detections first seen in a closed month keep counting there (the site is new in the month it was
 * first seen), but a closed month is never recomputed under the same version: a method change creates a
 * new INDEX_VERSION and a corrections entry, and reprocesses the whole series.
 */
export interface CloseResult {
  month: string;
  version: string;
  monthsWritten: string[];
  sites: number;
  national: { newHa: number; cumHa: number; ciLow: number | null; ciHigh: number | null; districtsAffected: number; topDistrictId: string | null };
  precision: RateSample | null;
  detection: RateSample | null;
  dryRun: boolean;
}

export async function closeMonth(month: string, opts: { dryRun?: boolean; reprocess?: boolean; force?: string[]; log?: (s: string) => void } = {}): Promise<CloseResult> {
  const log = opts.log ?? (() => undefined);
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Not a month: ${month}`);
  if (month >= monthOf(new Date())) throw new Error(`${month} has not ended yet; a month closes after it ends`);
  const db = await getDb();
  const { sites, districts, legalityKnown } = await loadSites();
  const { precision, detection } = await latestRates();
  const [earliestClosed] = toRows<{ m: string | null }>(await db.execute(sql`select min(month) as m from national_months where index_version = ${INDEX_VERSION}`));
  const start = seriesStart(sites, month, earliestClosed?.m);
  const months = monthsBetween(start, month);
  log(`index: ${sites.length} sites from ${start} to ${month}, precision ${precision ? `${precision.k}/${precision.n}` : "none"}, detection rate ${detection ? `${detection.k}/${detection.n}` : "none"}`);
  const built = buildIndex(sites, districts, months, { precision, detection, legalityKnown });

  const closed = new Set(
    toRows<{ m: string }>(await db.execute(sql`select distinct month as m from national_months where index_version = ${INDEX_VERSION}`)).map((r) => r.m),
  );
  const force = new Set(opts.force ?? []);
  const toWrite = opts.reprocess ? months : months.filter((m) => !closed.has(m) || force.has(m));
  const nat = built.national.find((n) => n.month === month)!;
  if (opts.dryRun) {
    log(`index: dry run, would write ${toWrite.length} months (${toWrite[0] ?? "none"} to ${toWrite.at(-1) ?? "none"})`);
    return { month, version: INDEX_VERSION, monthsWritten: toWrite, sites: sites.length, national: nat, precision, detection, dryRun: true };
  }
  for (const m of toWrite) {
    const rowsForMonth = built.districts.filter((r) => r.month === m);
    for (let i = 0; i < rowsForMonth.length; i += 200) {
      await db
        .insert(districtMonths)
        .values(
          rowsForMonth.slice(i, i + 200).map((r) => ({
            districtId: r.districtId,
            month: r.month,
            indexVersion: INDEX_VERSION,
            newHa: r.newHa,
            cumHa: r.cumHa,
            index: r.index,
            rank: r.rank,
            newSites: r.newSites,
            activeSites: r.activeSites,
            pctForest: r.pctForest,
            pctRiver: r.pctRiver,
            pctUnlicensed: r.pctUnlicensed,
            ciLow: r.ciLow,
            ciHigh: r.ciHigh,
            closedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [districtMonths.districtId, districtMonths.month, districtMonths.indexVersion],
          set: {
            newHa: sql`excluded.new_ha`,
            cumHa: sql`excluded.cum_ha`,
            index: sql`excluded.index`,
            rank: sql`excluded.rank`,
            newSites: sql`excluded.new_sites`,
            activeSites: sql`excluded.active_sites`,
            pctForest: sql`excluded.pct_forest`,
            pctRiver: sql`excluded.pct_river`,
            pctUnlicensed: sql`excluded.pct_unlicensed`,
            ciLow: sql`excluded.ci_low`,
            ciHigh: sql`excluded.ci_high`,
            closedAt: sql`excluded.closed_at`,
          },
        });
    }
    const n = built.national.find((x) => x.month === m)!;
    await db
      .insert(nationalMonths)
      .values({
        month: m,
        indexVersion: INDEX_VERSION,
        newHa: n.newHa,
        cumHa: n.cumHa,
        ciLow: n.ciLow,
        ciHigh: n.ciHigh,
        newSites: n.newSites,
        districtsAffected: n.districtsAffected,
        topDistrictId: n.topDistrictId,
        inReservesHa: n.inReservesHa,
        closedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [nationalMonths.month, nationalMonths.indexVersion],
        set: {
          newHa: sql`excluded.new_ha`,
          cumHa: sql`excluded.cum_ha`,
          ciLow: sql`excluded.ci_low`,
          ciHigh: sql`excluded.ci_high`,
          newSites: sql`excluded.new_sites`,
          districtsAffected: sql`excluded.districts_affected`,
          topDistrictId: sql`excluded.top_district_id`,
          inReservesHa: sql`excluded.in_reserves_ha`,
          closedAt: sql`excluded.closed_at`,
        },
      });
  }
  // Record each history sighting's site month, for traceability of the series.
  const firstByMember = new Map<string, string>();
  for (const s of sites) for (const id of s.members) firstByMember.set(id, s.firstMonth);
  const pairs = [...firstByMember.entries()];
  for (let i = 0; i < pairs.length; i += 500) {
    await db.execute(sql`
      update history_events h set first_month = v.m
      from (select x->>'id' as id, x->>'m' as m from jsonb_array_elements(${JSON.stringify(pairs.slice(i, i + 500).map(([id, m]) => ({ id, m })))}::text::jsonb) x) v
      where h.id::text = v.id and h.first_month is distinct from v.m`);
  }
  clearIndexCache();
  log(`index: wrote ${toWrite.length} months; ${month}: ${nat.newHa} ha new (${nat.ciLow ?? "–"} to ${nat.ciHigh ?? "–"}), ${nat.cumHa} ha since ${start}`);
  return { month, version: INDEX_VERSION, monthsWritten: toWrite, sites: sites.length, national: nat, precision, detection, dryRun: false };
}

/** The latest whole-of-Ghana optical check (precision) and the latest blind detection-rate check. */
export async function latestRates(): Promise<{ precision: RateSample | null; detection: RateSample | null }> {
  const db = await getDb();
  const [p] = toRows<{ k: number; n: number }>(
    await db.execute(sql`select correct as k, checked as n from accuracy_checks where kind = 'optical' and headline order by checked_on desc, created_at desc limit 1`),
  );
  const [d] = toRows<{ k: number; n: number }>(await db.execute(sql`select correct as k, checked as n from accuracy_checks where kind = 'detection_rate' order by checked_on desc, created_at desc limit 1`));
  return {
    precision: p ? { k: Number(p.k), n: Number(p.n) } : null,
    detection: d ? { k: Number(d.k), n: Number(d.n) } : null,
  };
}
