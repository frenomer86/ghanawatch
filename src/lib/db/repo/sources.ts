import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb, rows as toRows } from "../client";
import { dataSources, pipelineRuns } from "../schema";
import type { DataFreshness } from "@/lib/domain/types";
import { STALE_AFTER_HOURS } from "@/lib/domain/types";

export interface SourceWithRun {
  id: string;
  slug: string;
  name: string;
  provider: string;
  url: string;
  docUrl: string | null;
  category: string;
  description: string;
  licence: string;
  attributionText: string;
  cadence: string | null;
  resolutionM: number | null;
  isActive: boolean;
  lastRun: { startedAt: string; finishedAt: string | null; status: string; inserted: number; error: string | null } | null;
}

export async function listSources(): Promise<SourceWithRun[]> {
  const db = await getDb();
  const sources = await db.select().from(dataSources).orderBy(asc(dataSources.category), asc(dataSources.name));
  const out: SourceWithRun[] = [];
  for (const s of sources) {
    const [run] = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.sourceId, s.id))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(1);
    out.push({
      ...s,
      lastRun: run
        ? {
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            status: run.status,
            inserted: run.inserted,
            error: run.error,
          }
        : null,
    });
  }
  return out;
}

export async function getSourceBySlug(slug: string) {
  const db = await getDb();
  const [s] = await db.select().from(dataSources).where(eq(dataSources.slug, slug)).limit(1);
  return s ?? null;
}

export async function getFreshness(now: Date = new Date()): Promise<DataFreshness> {
  const db = await getDb();
  const [last] = await db
    .select({ at: sql<string | null>`max(${pipelineRuns.finishedAt})` })
    .from(pipelineRuns)
    .where(sql`${pipelineRuns.status} in ('ok', 'partial')`);
  const [img] = toRows<{ d: string | null }>(await db.execute(sql`select max(image_date)::text as d from change_events`));
  const perSource = toRows<{ slug: string; name: string; last_run_at: string | null; status: string | null }>(
    await db.execute(sql`
    select s.slug, s.name, r.finished_at::text as last_run_at, r.status
    from data_sources s
    left join lateral (
      select finished_at, status from pipeline_runs where source_id = s.id order by started_at desc limit 1
    ) r on true
    where s.is_active
    order by s.name
  `),
  );
  const lastAt = last?.at ? new Date(last.at) : null;
  return {
    lastSuccessfulRunAt: lastAt ? lastAt.toISOString() : null,
    latestImageDate: img?.d ?? null,
    isStale: !lastAt || now.getTime() - lastAt.getTime() > STALE_AFTER_HOURS * 3_600_000,
    perSource: perSource.map((r) => ({
      slug: r.slug,
      name: r.name,
      lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
      status: r.status ?? "never",
    })),
  };
}

export interface RiverLevel {
  id: string;
  name: string;
  river: string;
  peak: number;
  peakDate: string;
  t2: number;
  t5: number;
  recordMax: number;
  ratio2: number;
}

/** River points from the latest successful GloFAS run, highest relative level first. */
export async function latestRiverLevels(): Promise<{ checkedAt: string | null; levels: RiverLevel[] }> {
  const db = await getDb();
  const [run] = await db
    .select({ finishedAt: pipelineRuns.finishedAt, summary: pipelineRuns.summary })
    .from(pipelineRuns)
    .innerJoin(dataSources, eq(dataSources.id, pipelineRuns.sourceId))
    .where(sql`${dataSources.slug} = 'copernicus-glofas' and ${pipelineRuns.status} = 'ok' and ${pipelineRuns.summary} is not null`)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(1);
  const levels = ((run?.summary as { statuses?: RiverLevel[] } | null)?.statuses ?? []).slice().sort((a, b) => b.ratio2 - a.ratio2);
  return { checkedAt: run?.finishedAt?.toISOString() ?? null, levels };
}

export interface MiningAreaStatus {
  aoi: string;
  name: string;
  coverageBefore: number;
  coverageAfter: number;
  sites: number;
  turbid: number;
}

/** Per-area summary from the latest successful Sentinel-2 galamsey run. */
export async function latestMiningAreas(): Promise<{ checkedAt: string | null; areas: MiningAreaStatus[] }> {
  const db = await getDb();
  const [run] = await db
    .select({ finishedAt: pipelineRuns.finishedAt, summary: pipelineRuns.summary })
    .from(pipelineRuns)
    .innerJoin(dataSources, eq(dataSources.id, pipelineRuns.sourceId))
    .where(sql`${dataSources.slug} = 'cdse-sentinel-2' and ${pipelineRuns.status} = 'ok' and ${pipelineRuns.summary} is not null`)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(1);
  const areas = ((run?.summary as { areas?: MiningAreaStatus[] } | null)?.areas ?? []).slice().sort((a, b) => b.sites - a.sites);
  return { checkedAt: run?.finishedAt?.toISOString() ?? null, areas };
}

export interface ScanStatus {
  cellsTotal: number;
  cellsScanned: number;
  lastScanAt: string | null;
  detections: number;
  withPits: number;
  sensitive: number;
  byRegion: Array<{ region: string; cells: number; scanned: number; sites: number }>;
}

/** Progress and findings of the nationwide Sentinel-2 galamsey scan. */
export async function nationalScanStatus(): Promise<ScanStatus> {
  const db = await getDb();
  const cells = toRows<{ region: string | null; cells: number; scanned: number; sites: number; last: string | null }>(
    await db.execute(sql`
      select c.region_name as region, count(*)::int as cells,
        -- A cell counts as scanned once the monthly record (detector 3.0) is current for it, or, before that
        -- detector has run anywhere, once the two-date scan has visited it.
        (case when exists (select 1 from history_progress where note like 'gw-ts%')
          then count(*) filter (where t.month is not null and t.month >= to_char(now() - interval '2 months', 'YYYY-MM'))
          else count(c.last_run_at) end)::int as scanned,
        coalesce(sum(s.n), 0)::int as sites, greatest(max(c.last_run_at), max(t.at))::text as last
      from analysis_cells c
      left join (select cell_id, max(scan_month) as month, max(scanned_at) as at from history_progress where note like 'gw-ts%' group by 1) t on t.cell_id = c.id
      left join (
        -- Only what the map shows: detections that passed the checks.
        select properties->>'cell' as cell, count(*)::int as n from change_events
        where method_version like 's2-galamsey-%' and type = 'surface_disturbance' and status <> 'dismissed' and confidence <> 'low'
        group by 1
      ) s on s.cell = c.id
      group by c.region_name order by sites desc`),
  );
  const [ev] = toRows<{ n: number; pits: number; sensitive: number }>(
    await db.execute(sql`
      select count(*)::int as n,
        count(*) filter (where properties->>'signature' in ('new_pits', 'cleared_with_pits', 'mining'))::int as pits,
        count(*) filter (where jsonb_array_length(coalesce(properties->'placement'->'flags', '[]'::jsonb)) > 0
          and (properties->'placement'->>'inResidential' = 'true' or properties->'placement'->>'protectedArea' is not null
            or exists (select 1 from jsonb_array_elements(properties->'placement'->'nearby') x
              where x->>'kind' in ('school', 'cemetery', 'health') and (x->>'distanceM')::int <= 300)))::int as sensitive
      from change_events where method_version like 's2-galamsey-%' and status <> 'dismissed' and confidence <> 'low'`),
  );
  const last = cells.map((c) => c.last).filter(Boolean).sort().pop() ?? null;
  return {
    cellsTotal: cells.reduce((s, c) => s + c.cells, 0),
    cellsScanned: cells.reduce((s, c) => s + c.scanned, 0),
    lastScanAt: last ? new Date(last).toISOString() : null,
    detections: ev?.n ?? 0,
    withPits: ev?.pits ?? 0,
    sensitive: ev?.sensitive ?? 0,
    byRegion: cells.map((c) => ({ region: (c.region ?? "Other").replace(/ Region$/, ""), cells: c.cells, scanned: c.scanned, sites: c.sites })),
  };
}
