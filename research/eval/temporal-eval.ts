/**
 * Old detector vs new detector on held-out SmallMinesDS ground, month by month, with the production code.
 *
 *   npx tsx research/eval/temporal-eval.ts --blocks=b2_3,b3_3 --from=2019-01 --to=2022-01 --out=/path [--old-from=2020-01]
 *
 * New (s2-galamsey-3.0): per month, the composite -> U-Net -> calibrated probability -> tracker, at 10 m
 * on the block grid. Saves the monthly probability (uint8) and, at the end, the tracker's onset, P(mined),
 * status and observation count.
 * Old (s2-galamsey-2.2): the two-date scan (processCell) run as if on the last day of each month from
 * --old-from, its detected pixels (cleared or new pits) put on the same grid; saves the first month each
 * pixel was detected (or -1).
 * research/eval/score.py compares both with the SmallMinesDS January 2022 masks of the test patches.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import proj4 from "proj4";
import { blockGrid, defineEpsg, gridLonLatBbox } from "@/pipeline/ts/cog";
import { buildDem, buildMonth } from "@/pipeline/ts/composite";
import { buildChannels, terrain } from "@/pipeline/ts/features";
import { calibrate, loadModel } from "@/pipeline/ts/model";
import { decodeState, encodeState, monthIndex, monthName, newState, REGIME, step, DEFAULT_PARAMS } from "@/pipeline/ts/tracker";
import { writeNpy } from "@/pipeline/ts/npy";
import { processCell } from "@/pipeline/s2/process";
import { SurfaceWater } from "@/pipeline/context/surface-water";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), headers: { "user-agent": "GhanaWatch/0.1 (research)", ...(init?.headers ?? {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

interface Block {
  id: string;
  epsg: number;
  bbox: [number, number, number, number];
  res: number;
}

/** Build and cache each month's channels and observation regime, so the model step can run later. */
async function runCube(b: Block, from: string, to: string, out: string) {
  const g = blockGrid(b.epsg, b.bbox, b.res);
  const n = g.width * g.height;
  const dir = join(out, b.id, "cube");
  mkdirSync(dir, { recursive: true });
  const dem = await buildDem(g, fetchJson);
  const t = terrain(dem, g.width, g.height, g.res);
  for (let mi = monthIndex(from); mi <= monthIndex(to); mi++) {
    const m = monthName(mi);
    if (existsSync(join(dir, `${m}.json`))) continue;
    const t0 = Date.now();
    const c = await buildMonth(g, m, fetchJson);
    const regime = new Uint8Array(n);
    for (let i = 0; i < n; i++) regime[i] = c.s2Obs[i] ? REGIME.sentinel2 : c.landsatObs[i] ? REGIME.landsat : c.s1Obs[i] ? REGIME.radar : REGIME.none;
    const ch = buildChannels(c, t, n);
    const flat = new Float32Array(ch.length * n);
    ch.forEach((p, k) => flat.set(p, k * n));
    writeNpy(join(dir, `${m}.npy`), flat, [ch.length, g.height, g.width], "f2");
    writeNpy(join(dir, `${m}_regime.npy`), regime, [g.height, g.width], "u1");
    writeFileSync(join(dir, `${m}.json`), JSON.stringify({ scenes: c.scenes, seconds: Math.round((Date.now() - t0) / 1000) }));
    console.log(`[cube] ${b.id} ${m}: ${c.scenes.s2.length} S2, ${c.scenes.landsat.length} Landsat, ${c.scenes.s1.length} S1 scenes, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

function readNpyF16(path: string): Float32Array {
  const buf = readFileSync(path);
  const hl = buf.readUInt16LE(8);
  const body = buf.subarray(10 + hl);
  const h = new Uint16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const x = h[i];
    const sgn = x & 0x8000 ? -1 : 1;
    const e = (x >> 10) & 0x1f;
    const f = x & 0x3ff;
    out[i] = e === 0 ? sgn * 2 ** -14 * (f / 1024) : e === 31 ? (f ? Number.NaN : sgn * Number.POSITIVE_INFINITY) : sgn * 2 ** (e - 15) * (1 + f / 1024);
  }
  return out;
}

function readNpyU8(path: string): Uint8Array {
  const buf = readFileSync(path);
  const hl = buf.readUInt16LE(8);
  return Uint8Array.from(buf.subarray(10 + hl));
}

async function runNew(b: Block, from: string, to: string, out: string, model: Awaited<ReturnType<typeof loadModel>>) {
  const g = blockGrid(b.epsg, b.bbox, b.res);
  const n = g.width * g.height;
  const dir = join(out, b.id);
  mkdirSync(join(dir, "prob"), { recursive: true });
  const statePath = join(dir, "state.gwts");
  const s = existsSync(statePath) ? decodeState(readFileSync(statePath)) : newState(n, { ...DEFAULT_PARAMS, modelPrior: model.meta.baseRate ?? DEFAULT_PARAMS.modelPrior });
  const params = { ...DEFAULT_PARAMS, modelPrior: model.meta.baseRate ?? DEFAULT_PARAMS.modelPrior };
  const needDem = !existsSync(join(dir, "cube"));
  const t = needDem ? terrain(await buildDem(g, fetchJson), g.width, g.height, g.res) : { slope: new Float32Array(0), relElev: new Float32Array(0) };
  const cover: Record<string, unknown>[] = existsSync(join(dir, "coverage.json")) ? JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")) : [];
  for (let mi = Math.max(monthIndex(from), s.lastMonth + 1); mi <= monthIndex(to); mi++) {
    const m = monthName(mi);
    const t0 = Date.now();
    const cached = join(dir, "cube", `${m}.npy`);
    let ch: Float32Array[];
    let regime: Uint8Array;
    let scenes = { s2: 0, landsat: 0, s1: 0 };
    if (existsSync(cached)) {
      const flat = readNpyF16(cached);
      ch = Array.from({ length: flat.length / n }, (_, k) => flat.slice(k * n, (k + 1) * n));
      regime = readNpyU8(join(dir, "cube", `${m}_regime.npy`));
      const sc = JSON.parse(readFileSync(join(dir, "cube", `${m}.json`), "utf8")).scenes;
      scenes = { s2: sc.s2.length, landsat: sc.landsat.length, s1: sc.s1.length };
    } else {
      const c = await buildMonth(g, m, fetchJson);
      regime = new Uint8Array(n);
      for (let i = 0; i < n; i++) regime[i] = c.s2Obs[i] ? REGIME.sentinel2 : c.landsatObs[i] ? REGIME.landsat : c.s1Obs[i] ? REGIME.radar : REGIME.none;
      ch = buildChannels(c, t, n);
      scenes = { s2: c.scenes.s2.length, landsat: c.scenes.landsat.length, s1: c.scenes.s1.length };
    }
    let s2 = 0, ls = 0, rd = 0;
    for (let i = 0; i < n; i++) {
      if (regime[i] === 1) s2++;
      else if (regime[i] === 2) ls++;
      else if (regime[i] === 3) rd++;
    }
    const prob = await model.predict(ch, g.width, g.height);
    const names: Record<number, string> = { 1: "sentinel2", 2: "landsat", 3: "radar" };
    const q = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      prob[i] = regime[i] ? calibrate(prob[i], names[regime[i]], model.meta) : Number.NaN;
      q[i] = Number.isFinite(prob[i]) ? Math.round(prob[i] * 254) + 1 : 0; // 0 = no observation
    }
    writeNpy(join(dir, "prob", `${m}.npy`), q, [g.height, g.width], "u1");
    step(s, mi, prob, regime, params);
    writeFileSync(statePath, encodeState(s));
    cover.push({ month: m, sentinel2: s2 / n, landsat: ls / n, radarOnly: rd / n, none: (n - s2 - ls - rd) / n, scenes, seconds: Math.round((Date.now() - t0) / 1000) });
    writeFileSync(join(dir, "coverage.json"), JSON.stringify(cover, null, 1));
    console.log(`[new] ${b.id} ${m}: S2 ${Math.round((s2 / n) * 100)}% Landsat ${Math.round((ls / n) * 100)}% radar-only ${Math.round((rd / n) * 100)}% ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  writeNpy(join(dir, "onset.npy"), Float32Array.from(s.onset), [g.height, g.width], "f4");
  writeNpy(join(dir, "p1.npy"), s.p1, [g.height, g.width], "f4");
  writeNpy(join(dir, "p2.npy"), s.p2, [g.height, g.width], "f4");
  writeNpy(join(dir, "observed.npy"), Float32Array.from(s.observed), [g.height, g.width], "f4");
}

async function runOld(b: Block, from: string, to: string, out: string) {
  const g = blockGrid(b.epsg, b.bbox, b.res);
  const n = g.width * g.height;
  const dir = join(out, b.id);
  mkdirSync(dir, { recursive: true });
  const firstPath = join(dir, "old_first.json");
  const first = existsSync(firstPath) ? Int16Array.from(JSON.parse(readFileSync(firstPath, "utf8")).first) : new Int16Array(n).fill(-1);
  const donePath = join(dir, "old_done.json");
  const done: string[] = existsSync(donePath) ? JSON.parse(readFileSync(donePath, "utf8")) : [];
  const bbox = gridLonLatBbox(g);
  const water = new SurfaceWater();
  const from32630 = defineEpsg(b.epsg);
  for (let mi = monthIndex(from); mi <= monthIndex(to); mi++) {
    const m = monthName(mi);
    if (done.includes(m)) continue;
    const [y, mm] = m.split("-").map(Number);
    const now = new Date(Date.UTC(y, mm, 0, 23, 59, 59));
    const t0 = Date.now();
    const r = await processCell({ id: b.id, name: b.id, bbox, res: 20, turbidity: false }, now, fetchJson, () => undefined, water);
    let hits = 0;
    if (r) {
      // Map each of our 10 m pixels to the old scan's 20 m grid (same UTM zone when epsg matches, else proj4).
      const same = r.epsg === b.epsg;
      const toOld = same ? null : defineEpsg(r.epsg);
      const mask = new Uint8Array(r.grid.width * r.grid.height);
      for (const c of r.comps) if (c.kind === "disturbance") for (const p of c.pixels) mask[p] = 1;
      for (let yy = 0; yy < g.height; yy++) {
        for (let xx = 0; xx < g.width; xx++) {
          let X = g.bbox[0] + (xx + 0.5) * g.res;
          let Y = g.bbox[3] - (yy + 0.5) * g.res;
          if (toOld) [X, Y] = proj4(from32630, toOld, [X, Y]) as [number, number];
          const ox = Math.floor((X - r.grid.bbox[0]) / r.grid.res);
          const oy = Math.floor((r.grid.bbox[3] - Y) / r.grid.res);
          if (ox < 0 || oy < 0 || ox >= r.grid.width || oy >= r.grid.height) continue;
          if (mask[oy * r.grid.width + ox]) {
            hits++;
            const i = yy * g.width + xx;
            if (first[i] < 0) first[i] = mi;
          }
        }
      }
    }
    done.push(m);
    writeFileSync(firstPath, JSON.stringify({ first: Array.from(first) }));
    writeFileSync(donePath, JSON.stringify(done));
    console.log(`[old] ${b.id} ${m}: ${r ? r.comps.length : "no imagery"} detections, ${hits} px, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  writeNpy(join(dir, "old_first.npy"), Float32Array.from(first), [g.height, g.width], "f4");
}

async function main() {
  const blocks = (JSON.parse(readFileSync(arg("blocks-file") ?? "research/smallmines/blocks_2022.json", "utf8")) as Block[]).filter((b) => arg("blocks")!.split(",").includes(b.id));
  const from = arg("from") ?? "2019-01";
  const to = arg("to") ?? "2022-01";
  const out = arg("out")!;
  const which = arg("which") ?? "new,old";
  if (which.includes("cube")) for (const b of blocks) await runCube(b, from, to, out);
  if (which.includes("new")) {
    const model = await loadModel(arg("model"));
    for (const b of blocks) await runNew(b, from, to, out, model);
  }
  if (which.includes("old")) for (const b of blocks) await runOld(b, arg("old-from") ?? "2020-01", to, out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
