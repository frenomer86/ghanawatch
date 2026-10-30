import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockGrid } from "./cog";
import { buildDem, buildMonth } from "./composite";
import { buildChannels, N_CH, terrain } from "./features";
import { writeNpy } from "./npy";

/**
 * Build GhanaWatch monthly composites for a list of blocks and cut them into patches, in exactly the form
 * the live detector computes them. Used to make training and test data for the mining-state model on the
 * SmallMinesDS footprints, so the model learns from the inputs it will see in production.
 *
 *   npx tsx src/pipeline/ts/cube-cli.ts --blocks=research/smallmines/blocks_2022.json \
 *       --months=2021-12,2022-01,2022-02 --out=/path/to/cube [--only=b0_1,b2_3] [--block-concurrency=2]
 *
 * Writes <out>/<month>/<pid>.npy (float16, 24 x 128 x 128 channels) and <out>/<month>/<block>.json
 * (observation counts and scenes used). Finished blocks are skipped, so a stopped run resumes.
 */
interface Block {
  id: string;
  epsg: number;
  bbox: [number, number, number, number];
  res: number;
  patches: Array<{ pid: string; col: number; row: number; split: string }>;
}

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
  const blocks = JSON.parse(readFileSync(arg("blocks")!, "utf8")) as Block[];
  const months = arg("months")!.split(",");
  const out = arg("out")!;
  const only = arg("only") ? new Set(arg("only")!.split(",")) : null;
  const conc = Number(arg("block-concurrency") ?? 1);
  const P = 128;
  const queue = blocks.filter((b) => !only || only.has(b.id));
  const t0 = Date.now();
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const b = queue.shift()!;
      const todo = months.filter((m) => !existsSync(join(out, m, `${b.id}.json`)));
      if (!todo.length) continue;
      const g = blockGrid(b.epsg, b.bbox, b.res);
      const n = g.width * g.height;
      const dem = await buildDem(g, fetchJson);
      const t = terrain(dem, g.width, g.height, g.res);
      for (const m of todo) {
        const tb = Date.now();
        const c = await buildMonth(g, m, fetchJson, (s) => console.error(s));
        const ch = buildChannels(c, t, n);
        mkdirSync(join(out, m), { recursive: true });
        const buf = new Float32Array(N_CH * P * P);
        for (const p of b.patches) {
          for (let k = 0; k < N_CH; k++) {
            for (let y = 0; y < P; y++) {
              const src = (p.row * P + y) * g.width + p.col * P;
              buf.set(ch[k].subarray(src, src + P), k * P * P + y * P);
            }
          }
          writeNpy(join(out, m, `${p.pid}.npy`), buf, [N_CH, P, P], "f2");
        }
        let s2 = 0, ls = 0, s1 = 0, opt = 0;
        for (let i = 0; i < n; i++) {
          s2 += c.s2Obs[i];
          ls += c.landsatObs[i];
          s1 += c.s1Obs[i] ? 1 : 0;
          opt += c.optOk[i];
        }
        const stats = { block: b.id, month: m, pixels: n, opticalCover: opt / n, s2ObsMean: s2 / n, landsatObsMean: ls / n, radarCover: s1 / n, scenes: c.scenes, seconds: Math.round((Date.now() - tb) / 1000) };
        writeFileSync(join(out, m, `${b.id}.json`), JSON.stringify(stats));
        console.log(JSON.stringify({ ...stats, scenes: { s2: c.scenes.s2.length, landsat: c.scenes.landsat.length, s1: c.scenes.s1.length } }));
      }
      done++;
      console.error(`[cube] ${done} blocks done, ${queue.length} left, ${Math.round((Date.now() - t0) / 60000)} min`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
