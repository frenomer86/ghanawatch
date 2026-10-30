import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { closeDb, getDb, migrateDb } from "@/lib/db/client";
import { analysisCells, historyEvents } from "@/lib/db/schema";
import { previousMonth, monthOf } from "@/lib/domain/index";
import { catchUp, TRACKER_START, writeHistory } from "../adapters/timeseries";
import { ContextIndex } from "../context/annotate";
import { DistrictIndex, loadDistricts } from "../districts";
import { loadModel } from "../ts/model";
import type { Db } from "@/lib/db/client";

/**
 * Historical backfill for the multi-sensor detector: every cell's tracker run month by month from
 * GW_TS_START (2017-01) to --to, writing the index's history rows as it goes. Resumable: each cell
 * continues from its saved tracker state.
 *
 *   npm run pipeline:history-ts -- [--to=2026-09] [--priority=2] [--cells=c12_7,c13_7] [--concurrency=2]
 *
 * On a second machine (the lab PC) the same command runs against its own local database; then
 *   npm run pipeline:history-ts -- --export=ts-export      # history rows to JSON
 * and on the server
 *   npm run pipeline:history-ts -- --import=ts-export      # rows into history_events
 * and copy .data/ts/state/ (the tracker states, gzip) so the live detector continues where the backfill stopped.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), headers: { "user-agent": "GhanaWatch/0.1 (environmental monitoring)", ...(init?.headers ?? {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 100)}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const log = (s: string) => console.log(`[history-ts] ${s}`);
  await migrateDb();
  const db = await getDb();
  if (arg("export")) return exportRows(db, arg("export")!, log).finally(closeDb);
  if (arg("import")) return importRows(db, arg("import")!, log).finally(closeDb);
  const to = arg("to") ?? previousMonth(monthOf(new Date()));
  const priority = Number(arg("priority") ?? 1);
  const only = arg("cells") ? new Set(arg("cells")!.split(",").map((x) => x.trim())) : null;
  const conc = Math.max(1, Number(arg("concurrency") ?? 1));
  const model = await loadModel();
  const districts = new DistrictIndex(await loadDistricts(db));
  const context = await ContextIndex.load(db);
  const cells = (await db.select().from(analysisCells)).filter((c) => (only ? only.has(c.id) : c.priority >= priority)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  log(`${cells.length} cells from ${TRACKER_START} to ${to}, ${conc} at a time`);
  const queue = [...cells];
  const t0 = Date.now();
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift()!;
      const tc = Date.now();
      let months = 0;
      try {
        await catchUp(c, to, model, fetchJson, () => undefined, async (r) => {
          await writeHistory(db, r, districts, context);
          months++;
          if (months % 6 === 0) log(`${c.id} at ${r.month}: ${r.sites.length} sites, S2 ${Math.round(r.coverage.sentinel2 * 100)}% Landsat ${Math.round(r.coverage.landsat * 100)}% radar-only ${Math.round(r.coverage.radar * 100)}%`);
        });
      } catch (e) {
        log(`${c.id} stopped: ${e instanceof Error ? e.message : String(e)} (it resumes from its last month next time)`);
      }
      done++;
      log(`${done}/${cells.length} ${c.id}: ${months} months in ${Math.round((Date.now() - tc) / 60000)} min (total ${Math.round((Date.now() - t0) / 60000)} min)`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  await closeDb();
}

async function exportRows(db: Db, dir: string, log: (s: string) => void) {
  mkdirSync(dir, { recursive: true });
  const rows = await db.select().from(historyEvents);
  const mine = rows.filter((r) => r.methodVersion.startsWith("s2-galamsey-3."));
  for (let i = 0; i < mine.length; i += 5000) writeFileSync(join(dir, `rows-${String(i / 5000).padStart(4, "0")}.json`), JSON.stringify(mine.slice(i, i + 5000)));
  log(`${mine.length} history rows written to ${dir}; copy .data/ts/state/ too`);
}

async function importRows(db: Db, dir: string, log: (s: string) => void) {
  if (!existsSync(dir)) throw new Error(`${dir} not found`);
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => /^rows-\d+\.json$/.test(x)).sort()) {
    const rows = JSON.parse(readFileSync(join(dir, f), "utf8")) as Array<typeof historyEvents.$inferInsert>;
    for (const r of rows) {
      r.createdAt = r.createdAt ? new Date(r.createdAt) : undefined;
    }
    for (let i = 0; i < rows.length; i += 200) await db.insert(historyEvents).values(rows.slice(i, i + 200)).onConflictDoNothing();
    n += rows.length;
  }
  log(`${n} history rows imported`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
