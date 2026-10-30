import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanCell, type CellScan } from "../adapters/sentinel2";
import { SurfaceWater } from "../context/surface-water";

/**
 * The national Sentinel-2 scan without a database, for a machine with a fast connection:
 *
 *   npx tsx src/pipeline/s2/remote-scan.ts --cells=cells.json --out=scan-out [--concurrency=6]
 *
 * cells.json is a list of analysis cells ({ id, regionName, minLon, minLat, maxLon, maxLat, resM, priority }).
 * Each finished cell is written to <out>/<id>.json at once, so a stopped run resumes where it left off;
 * cells that failed (usually the network) are tried again at the end. Bring the folder back and save it with
 *
 *   S2_IMPORT_DIR=scan-out npm run pipeline -- --only=cdse-sentinel-2
 *
 * which adds place context, districts and confidence rules exactly as a local scan would.
 */
type Cell = Parameters<typeof scanCell>[0];

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

async function main() {
  const cellsFile = arg("cells");
  const out = arg("out") ?? "scan-out";
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 6));
  if (!cellsFile) throw new Error("--cells=cells.json is required");
  mkdirSync(out, { recursive: true });
  const cells = JSON.parse(readFileSync(cellsFile, "utf8")) as Cell[];
  const finished = (id: string) => {
    const f = join(out, `${id}.json`);
    return existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as CellScan).status !== "failed";
  };
  const water = new SurfaceWater();
  const now = new Date();
  const log = (m: string) => console.log(m);

  for (let pass = 1; pass <= 3; pass++) {
    const queue = cells.filter((c) => !finished(c.id));
    if (!queue.length) break;
    console.log(`pass ${pass}: ${queue.length} cells to scan, ${concurrency} at a time`);
    let n = 0;
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift()!;
        const t0 = Date.now();
        const scan = await scanCell(c, now, fetchJson, () => undefined, water);
        writeFileSync(join(out, `${c.id}.json`), JSON.stringify(scan));
        n++;
        log(`${n}/${cells.length} ${c.id} ${scan.status} ${scan.evs.length} detections ${scan.coverageAfter ?? 0}% clear ${Math.round((Date.now() - t0) / 1000)} s${scan.note ? ` (${scan.note})` : ""}`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  const left = cells.filter((c) => !finished(c.id)).length;
  console.log(left ? `done, ${left} cells still failing` : "done, every cell scanned");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
