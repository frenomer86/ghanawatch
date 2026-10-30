/**
 * Cost of one block-month of the monthly record: bytes downloaded, seconds, peak memory (docs/deployment.md).
 *   npx tsx research/eval/measure-cost.ts <block> <YYYY-MM> [res]
 */
import { blockGrid } from "@/pipeline/ts/cog";
import { buildDem, buildMonth } from "@/pipeline/ts/composite";
import { buildChannels, terrain } from "@/pipeline/ts/features";
import { loadModel } from "@/pipeline/ts/model";
import { readFileSync } from "node:fs";

let bytes = 0, requests = 0;
const orig = globalThis.fetch;
globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
  const r = await orig(...a);
  const buf = await r.arrayBuffer();
  bytes += buf.byteLength; requests++;
  return new Response(buf, { status: r.status, statusText: r.statusText, headers: r.headers });
}) as typeof fetch;
const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => (await (await fetch(url, init)).json()) as T;

async function main() {
  const b = (JSON.parse(readFileSync("research/smallmines/blocks_2022.json", "utf8")) as Array<{ id: string; epsg: number; bbox: [number, number, number, number]; res: number }>).find((x) => x.id === process.argv[2])!;
  const month = process.argv[3];
  const res = Number(process.argv[4] ?? b.res);
  // At 20 m a production block (1,024 px) covers 20.48 km: widen the 10.24 km test block around its centre.
  const k = (1024 * res) / 2, cx = (b.bbox[0] + b.bbox[2]) / 2, cy = (b.bbox[1] + b.bbox[3]) / 2;
  const g = blockGrid(b.epsg, res === b.res ? b.bbox : [cx - k, cy - k, cx + k, cy + k], res);
  let t = Date.now();
  const dem = await buildDem(g, fetchJson);
  const demBytes = bytes; const demS = (Date.now() - t) / 1000;
  t = Date.now(); bytes = 0;
  const comp = await buildMonth(g, month, fetchJson, () => undefined);
  const compS = (Date.now() - t) / 1000;
  const model = await loadModel();
  t = Date.now();
  await model.predict(buildChannels(comp, terrain(dem, g.width, g.height, g.res), g.width * g.height), g.width, g.height);
  const predS = (Date.now() - t) / 1000;
  console.log(JSON.stringify({ block: b.id, month, res, px: g.width * g.height, scenes: { s2: comp.scenes.s2.length, landsat: comp.scenes.landsat.length, s1: comp.scenes.s1.length },
    demMB: +(demBytes / 1e6).toFixed(1), monthMB: +(bytes / 1e6).toFixed(1), requests, demSeconds: demS, compositeSeconds: compS, predictSeconds: predS,
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
}
main();
