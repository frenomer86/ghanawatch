import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { sql } from "drizzle-orm";
import { closeDb, getDb, migrateDb, rows as toRows, type Db } from "@/lib/db/client";
import { analysisCells, historyEvents, historyProgress } from "@/lib/db/schema";
import { monthsBetween } from "@/lib/domain/index";
import { bboxOf, centroidOf } from "@/lib/geo";
import { stableId } from "@/lib/server/ids";
import { readCellScan, scanCell, type CellScan } from "../adapters/sentinel2";
import type { NormalisedEvent } from "../adapters/types";
import { ContextIndex } from "../context/annotate";
import { SurfaceWater } from "../context/surface-water";
import { DistrictIndex, loadDistricts } from "../districts";

/**
 * The historical scan: the national Sentinel-2 galamsey method run with a past "now", once per cell per
 * month, so the index has a series from 2020 (baseline imagery from 2019) instead of starting the day
 * GhanaWatch went live. Results go to history_events, never to the live map.
 *
 *   npm run pipeline:history -- --from=2020-01 --to=2026-09 [--priority=2] [--cells=c12_7,c13_7]
 *                                [--concurrency=2] [--budget-minutes=600] [--out=history-out]
 *   npm run pipeline:history -- --import=history-out
 *
 * Priority-2 cells (the gold belt) are scanned every month; priority-1 cells every third month unless
 * --priority=1 asks for all of them monthly. A cell-month already in history_progress is skipped, so a
 * stopped run resumes. --out writes each cell-month to <out>/<month>/<cell>.json without a database
 * (for the lab PC); --import reads such a folder in.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), headers: { "user-agent": "GhanaWatch/0.1 (environmental monitoring)", ...(init?.headers ?? {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** The last instant of a month, the "now" the scan is run as. */
export function endOfMonth(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0, 23, 59, 59));
}

async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const log = (s: string) => console.log(`[history] ${s}`);
  await migrateDb();
  const db = await getDb();
  const importDir = arg("import");
  if (importDir) {
    await importFolder(db, importDir, log);
    await closeDb();
    return;
  }
  const from = arg("from") ?? "2020-01";
  const to = arg("to") ?? "2026-09";
  const priorityArg = Number(arg("priority") ?? 2);
  const only = arg("cells") ? new Set(arg("cells")!.split(",").map((x) => x.trim())) : null;
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 2));
  const budgetMs = Number(arg("budget-minutes") ?? 600) * 60_000;
  const out = arg("out") ?? null;
  const months = monthsBetween(from, to);
  const cells = (await db.select().from(analysisCells)).filter((c) => (only ? only.has(c.id) : priorityArg === 1 || c.priority >= 2)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const done = new Set(toRows<{ k: string }>(await db.execute(sql`select cell_id || ':' || scan_month as k from history_progress where status <> 'failed'`)).map((r) => r.k));
  const queue: Array<{ cell: (typeof cells)[number]; month: string }> = [];
  for (const cell of cells) {
    for (const month of months) {
      // Priority-1 cells quarterly unless asked for monthly.
      if (cell.priority < 2 && priorityArg !== 1 && Number(month.slice(5)) % 3 !== 1) continue;
      if (done.has(`${cell.id}:${month}`)) continue;
      if (out && existsSync(join(out, month, `${cell.id}.json`))) continue;
      queue.push({ cell, month });
    }
  }
  log(`${queue.length} cell-months to scan (${cells.length} cells, ${months.length} months), ${concurrency} at a time, budget ${budgetMs / 60_000} min`);
  const water = new SurfaceWater();
  const districts = new DistrictIndex(await loadDistricts(db));
  const context = await ContextIndex.load(db);
  const started = Date.now();
  let n = 0;
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const { cell, month } = queue.shift()!;
      const t0 = Date.now();
      const scan = await scanCell(cell, endOfMonth(month), fetchJson, () => undefined, water);
      if (out) {
        mkdirSync(join(out, month), { recursive: true });
        writeFileSync(join(out, month, `${cell.id}.json`), JSON.stringify(scan));
      } else {
        await save(db, month, scan, districts, context);
      }
      n++;
      log(`${n}/${queue.length + n} ${month} ${cell.id} ${scan.status} ${scan.evs.length} detections ${scan.coverageAfter ?? 0}% clear ${Math.round((Date.now() - t0) / 1000)} s${scan.note ? ` (${scan.note.slice(0, 80)})` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(queue.length ? `stopped at the time budget, ${queue.length} cell-months left` : "every cell-month scanned");
  await closeDb();
}

async function importFolder(db: Db, dir: string, log: (s: string) => void) {
  const districts = new DistrictIndex(await loadDistricts(db));
  const context = await ContextIndex.load(db);
  const months = readdirSync(dir).filter((m) => /^20\d\d-\d\d$/.test(m)).sort();
  let n = 0;
  for (const month of months) {
    for (const f of readdirSync(join(dir, month)).filter((x) => x.endsWith(".json"))) {
      const scan = readCellScan(readFileSync(join(dir, month, f), "utf8"));
      await save(db, month, scan, districts, context);
      n++;
    }
    log(`${month}: imported`);
  }
  log(`${n} cell-months imported from ${dir}`);
}

/** Save one cell-month: its detections (placed in districts and against OSM context) and the progress row. */
async function save(db: Db, month: string, scan: CellScan, districts: DistrictIndex, context: ContextIndex) {
  const rows: Array<typeof historyEvents.$inferInsert> = [];
  for (const ev of scan.evs as NormalisedEvent[]) {
    const c = centroidOf(ev.geom);
    const b = bboxOf(ev.geom);
    const d = districts.find(c.lon, c.lat);
    if (!d) continue;
    const placement = context.place(c.lon, c.lat);
    rows.push({
      id: stableId("history", `${month}:${ev.sourceEventId}`),
      scanMonth: month,
      sourceEventId: ev.sourceEventId,
      type: ev.type,
      imageDate: ev.imageDate,
      confidence: ev.confidence,
      severity: ev.severity ?? "normal",
      areaHa: ev.areaHa ?? null,
      districtId: d.id,
      geom: ev.geom,
      bboxMinLon: b[0],
      bboxMinLat: b[1],
      bboxMaxLon: b[2],
      bboxMaxLat: b[3],
      centroidLon: c.lon,
      centroidLat: c.lat,
      methodVersion: ev.methodVersion,
      properties: { ...(ev.properties ?? {}), placement, cell: scan.id },
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db
      .insert(historyEvents)
      .values(rows.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [historyEvents.scanMonth, historyEvents.sourceEventId],
        set: { areaHa: sql`excluded.area_ha`, confidence: sql`excluded.confidence`, geom: sql`excluded.geom`, properties: sql`excluded.properties`, imageDate: sql`excluded.image_date` },
      });
  }
  await db
    .insert(historyProgress)
    .values({ cellId: scan.id, scanMonth: month, status: scan.status, sites: rows.length, coverageAfter: scan.coverageAfter, note: scan.note, scannedAt: new Date(scan.scannedAt) })
    .onConflictDoUpdate({
      target: [historyProgress.cellId, historyProgress.scanMonth],
      set: { status: sql`excluded.status`, sites: sql`excluded.sites`, coverageAfter: sql`excluded.coverage_after`, note: sql`excluded.note`, scannedAt: sql`excluded.scanned_at` },
    });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
