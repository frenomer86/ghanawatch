import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floodExtent } from "./flood";

/**
 * Radar flood outlines for past flood events, without a database, for a machine with a fast connection:
 *
 *   npx tsx src/pipeline/s1/remote-flood.ts --events=flood-events.json --out=flood-out
 *
 * flood-events.json is a list of { id, place, lon, lat, date } (date YYYY-MM-DD). Each finished event is
 * written to <out>/<id>.json (outline patches, flooded hectares, scenes used); a stopped run resumes.
 */
type Event = { id: string; place: string; lon: number; lat: number; date: string };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), headers: { "user-agent": "GhanaWatch/0.1", ...(init?.headers ?? {}) } });
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
  const file = arg("events");
  const out = arg("out") ?? "flood-out";
  if (!file) throw new Error("--events=flood-events.json is required");
  mkdirSync(out, { recursive: true });
  const events = JSON.parse(readFileSync(file, "utf8")) as Event[];
  for (const e of events) {
    const f = join(out, `${e.id}.json`);
    if (existsSync(f)) continue;
    const t0 = Date.now();
    try {
      const r = await floodExtent(fetchJson, e.lon, e.lat, new Date(`${e.date}T12:00:00Z`));
      writeFileSync(f, JSON.stringify({ event: e, status: r ? "ok" : "no-radar", result: r }));
      console.log(`${e.id} ${e.place} ${r ? `${r.floodedHa} ha in ${r.patches.length} patches` : "no radar passes"} ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) {
      console.log(`${e.id} ${e.place} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
