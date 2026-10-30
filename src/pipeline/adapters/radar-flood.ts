import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { rows as toRows, type Db } from "@/lib/db/client";
import type { BBox, Severity } from "@/lib/domain/types";
import type { Adapter, NormalisedEvent } from "./types";
import { FLOOD_RULES, floodBox, floodExtent, type FloodPatch } from "../s1/flood";
import { searchRadar, type RadarScene } from "../s1/pc";

/**
 * Flooding seen by radar, live.
 *
 * When GhanaWatch forecasts a flood (a GloFAS river forecast at its two-year level or above, or very heavy or
 * extreme rain in a district) or the public reports one, every Sentinel-1 pass over the place in the days that
 * follow is compared with the same weeks a year earlier (s1/flood.ts): land that has turned to open water is
 * outlined, through the cloud that comes with floods. Each outline is published as a flood record (type
 * flood_risk, signature radar_flood): on the flood map, in the district cards' flood count, and as satellite
 * evidence for flood reports. A forecast says water may come; this says where it did.
 *
 * New water that is not flooding (galamsey ponds, a new reservoir) can look the same, so outlines that lie in a
 * known mining site are dropped, and the description says so. Flooded forest and tall crops stay bright to
 * radar, so an outline is the least that flooded.
 */
export const SLUG = "s1-flood";
export const METHOD = "s1-flood-1.0";
/** Smallest outline published (hectares). */
export const MIN_HA = 10;
const MAX_PER_PASS = 15;
const DAY = 86_400_000;
const STATE_FILE = () => join(process.env.S1_FLOOD_DIR ?? join(process.cwd(), ".data", "s1-flood"), "state.json");

export interface FloodTrigger {
  key: string;
  kind: "river-forecast" | "rain-forecast" | "report";
  place: string;
  lon: number;
  lat: number;
  /** YYYY-MM-DD: the forecast peak, the rain day, or the day of the report. */
  date: string;
  priority: number;
}

/**
 * Triggers worth a radar look, most important first, with near-duplicates dropped: a trigger within about
 * 10 km and 3 days of one already chosen shares its radar square and passes.
 */
export function selectTriggers(all: FloodTrigger[]): FloodTrigger[] {
  const out: FloodTrigger[] = [];
  const sorted = [...all].sort((a, b) => b.priority - a.priority || b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
  for (const t of sorted) {
    const near = out.some(
      (o) => Math.abs(o.lon - t.lon) < 0.09 && Math.abs(o.lat - t.lat) < 0.09 && Math.abs(Date.parse(o.date) - Date.parse(t.date)) <= 3 * DAY,
    );
    if (!near) out.push(t);
  }
  return out;
}

/** Radar items grouped into passes (one satellite, one direction, one day), earliest first. */
export function groupPasses(items: RadarScene[]): Array<{ id: string; date: string; scenes: RadarScene[] }> {
  const by = new Map<string, RadarScene[]>();
  for (const s of items) {
    const id = `${s.datetime.slice(0, 10)}-${s.platform || "s1"}-${s.orbit}`;
    by.set(id, [...(by.get(id) ?? []), s]);
  }
  return [...by.entries()].map(([id, scenes]) => ({ id, date: id.slice(0, 10), scenes })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Outlines that are not flooding: within a known mining site (galamsey ponds also turn dark to radar). */
export function dropMining(patches: FloodPatch[], mining: BBox[], marginDeg = 0.001): FloodPatch[] {
  return patches.filter(
    (p) => !mining.some((b) => p.centre.lon >= b[0] - marginDeg && p.centre.lon <= b[2] + marginDeg && p.centre.lat >= b[1] - marginDeg && p.centre.lat <= b[3] + marginDeg),
  );
}

export function floodSeverity(ha: number): Severity {
  return ha >= 500 ? "urgent" : ha >= 100 ? "elevated" : "watch";
}

type State = Record<string, { passes: string[]; done: boolean; at: number }>;

function loadState(): State {
  try {
    return existsSync(STATE_FILE()) ? (JSON.parse(readFileSync(STATE_FILE(), "utf8")) as State) : {};
  } catch {
    return {};
  }
}

function saveState(s: State, now: Date) {
  for (const k of Object.keys(s)) if (now.getTime() - s[k].at > 60 * DAY) delete s[k];
  mkdirSync(join(STATE_FILE(), ".."), { recursive: true });
  writeFileSync(`${STATE_FILE()}.tmp`, JSON.stringify(s));
  renameSync(`${STATE_FILE()}.tmp`, STATE_FILE());
}

export async function loadTriggers(db: Db, now: Date): Promise<FloodTrigger[]> {
  const today = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);
  const events = toRows<{ id: string; method: string; title: string; lon: number; lat: number; severity: string; date: string; river: string | null; district: string | null }>(
    await db.execute(sql`select id::text, method_version as method, title_en as title, centroid_lon::float lon, centroid_lat::float lat, severity,
        coalesce(image_date_end, image_date)::text as date, properties->>'river' river, properties->>'district' district
      from change_events
      where type = 'flood_risk' and status <> 'dismissed' and centroid_lon is not null
        and coalesce(method_version, '') not like 's1-flood-%'
        and coalesce(image_date_end, image_date) between ${from} and ${today}
        and (method_version like 'glofas-%' or severity in ('elevated', 'urgent'))`),
  );
  const reports = toRows<{ id: string; lon: number; lat: number; date: string }>(
    await db.execute(sql`select id::text, lon::float lon, lat::float lat, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as date
      from community_reports where category = 'flooding' and status = 'approved' and created_at >= ${new Date(now.getTime() - 14 * DAY)}`),
  );
  return [
    ...events.map((e): FloodTrigger => {
      const river = e.method.startsWith("glofas-");
      return {
        key: `event:${e.id}`,
        kind: river ? "river-forecast" : "rain-forecast",
        place: river ? `the ${e.river ?? "river"}` : (e.district ?? "the district"),
        lon: Number(e.lon),
        lat: Number(e.lat),
        date: e.date,
        priority: (river ? 2 : 1) + (e.severity === "urgent" ? 1 : 0),
      };
    }),
    ...reports.map((r): FloodTrigger => ({ key: `report:${r.id}`, kind: "report", place: "a public flood report", lon: Number(r.lon), lat: Number(r.lat), date: r.date, priority: 3 })),
  ];
}

async function miningBoxes(db: Db, b: BBox): Promise<BBox[]> {
  const rows = toRows<{ a: number; b: number; c: number; d: number }>(
    await db.execute(sql`select bbox_min_lon::float a, bbox_min_lat::float b, bbox_max_lon::float c, bbox_max_lat::float d from change_events
      where status <> 'dismissed' and bbox_min_lon is not null
        and ((method_version like 's2-galamsey-%' and properties->>'signature' in ('new_pits', 'cleared_with_pits', 'mining')) or method_version like 's1-water-%')
        and bbox_max_lon >= ${b[0]} and bbox_min_lon <= ${b[2]} and bbox_max_lat >= ${b[1]} and bbox_min_lat <= ${b[3]}`),
  );
  return rows.map((r) => [Number(r.a), Number(r.b), Number(r.c), Number(r.d)] as BBox);
}

const why: Record<FloodTrigger["kind"], string> = {
  "river-forecast": "a GloFAS forecast of the river reaching its two-year flood level",
  "rain-forecast": "a forecast of very heavy rain",
  report: "a flood reported by the public and approved by a moderator",
};

export function toEvent(t: FloodTrigger, passId: string, passDate: string, p: FloodPatch, totalHa: number, coverage: number, baseline: number, now: Date): NormalisedEvent {
  const ha = Math.round(p.areaHa);
  return {
    sourceSlug: SLUG,
    sourceEventId: `${passId}-${p.centre.lon.toFixed(3)}-${p.centre.lat.toFixed(3)}`,
    type: "flood_risk",
    detectedAt: now,
    imageDate: passDate,
    confidence: ha >= 50 && coverage >= 0.8 ? "high" : ha >= 20 ? "medium" : "low",
    confidenceScore: ha >= 50 && coverage >= 0.8 ? 0.85 : ha >= 20 ? 0.65 : 0.45,
    severity: floodSeverity(ha),
    areaHa: Math.round(p.areaHa * 10) / 10,
    geom: p.geom,
    titleEn: `Flooding seen by radar near ${t.place}: about ${ha} ha under water on ${passDate}`,
    titleTw: `Nsuyire a radar ahu wɔ ${t.place} nkyɛn: bɛyɛ ${ha} ha nsuo ayi so`,
    descriptionEn:
      `Sentinel-1 radar, which sees through cloud, passed over on ${passDate}, after ${why[t.kind]} (${t.date}). Land here that was dry in the same weeks a year earlier had turned to open water: about ${ha} ha in this outline, ${Math.round(totalHa)} ha in all within 15 km. ` +
      "Flooded forest and tall crops can stay bright to radar, so the outline is the least that flooded; new ponds and reservoirs can look the same as flood water, so outlines inside known mining sites are left out. This is a satellite observation, not an official flood declaration.",
    descriptionTw: "Radar a ɛhunu mununkum mu kyerɛ sɛ nsuo ayi asase yi so. Ɛyɛ satellite nhwehwɛmu, ɛnyɛ aban dawurubɔ.",
    methodVersion: METHOD,
    properties: {
      signature: "radar_flood",
      trigger: { kind: t.kind, ref: t.key, date: t.date, place: t.place },
      pass: passId,
      floodedHaInSquare: Math.round(totalHa),
      radarCoverage: Math.round(coverage * 100) / 100,
      baselinePasses: baseline,
      rules: FLOOD_RULES,
    },
  };
}

export const radarFloodAdapter: Adapter = {
  slug: SLUG,
  async run(ctx) {
    if (!ctx.db) throw new Error("database handle required");
    const db = ctx.db;
    const started = Date.now();
    const budgetMs = Number(process.env.S1_FLOOD_BUDGET_MINUTES ?? 15) * 60_000;
    const maxPasses = Number(process.env.S1_FLOOD_MAX_PASSES ?? 8);
    const triggers = selectTriggers(await loadTriggers(db, ctx.now));
    const state = loadState();
    const notes: string[] = [];
    let checked = 0;
    let published = 0;
    const out: NormalisedEvent[] = [];
    for (const t of triggers) {
      if (checked >= maxPasses || Date.now() - started > budgetMs) break;
      const st = (state[t.key] ??= { passes: [], done: false, at: ctx.now.getTime() });
      if (st.done) continue;
      const start = Date.parse(`${t.date}T00:00:00Z`);
      if (start > ctx.now.getTime()) continue;
      const end = Math.min(start + FLOOD_RULES.windowDays * DAY, ctx.now.getTime());
      try {
        const box = floodBox(t.lon, t.lat);
        const passes = groupPasses(await searchRadar(ctx.fetchJson, { bbox: box }, new Date(start), new Date(end)));
        const todo = passes.filter((p) => !st.passes.includes(p.id));
        if (!todo.length) {
          if (ctx.now.getTime() > start + (FLOOD_RULES.windowDays + 2) * DAY) st.done = true;
          continue;
        }
        const pass = todo[0];
        checked++;
        const ext = await floodExtent(ctx.fetchJson, t.lon, t.lat, new Date(start), pass.scenes);
        st.passes.push(pass.id);
        st.at = ctx.now.getTime();
        if (!ext) {
          notes.push(`${t.key}: pass ${pass.id} has no baseline a year earlier`);
          continue;
        }
        if (ext.coverage < 0.3) {
          ctx.log(`${SLUG}: ${t.place} ${pass.id}: radar covered ${Math.round(ext.coverage * 100)}% of the square, skipped`);
          continue;
        }
        const kept = dropMining(ext.patches, await miningBoxes(db, box)).filter((p) => p.areaHa >= MIN_HA).slice(0, MAX_PER_PASS);
        const evs = kept.map((p) => toEvent(t, pass.id, pass.date, p, ext.floodedHa, ext.coverage, ext.baselineScenes.length, ctx.now));
        if (ctx.emit) await ctx.emit(evs);
        else out.push(...evs);
        published += evs.length;
        ctx.log(`${SLUG}: ${t.place} (${t.kind}, ${t.date}), pass ${pass.id}: ${ext.floodedHa} ha newly under water, ${evs.length} outlines of ${MIN_HA} ha or more published`);
      } catch (e) {
        notes.push(`${t.key}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      }
    }
    saveState(state, ctx.now);
    return { events: out, watermark: ctx.now, notes: notes.slice(0, 20), extra: { triggers: triggers.length, passesChecked: checked, outlines: published } };
  },
};
