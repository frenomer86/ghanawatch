import { eq, gte, sql } from "drizzle-orm";
import { districtForestLoss } from "@/lib/db/schema";
import { pointInPolygon } from "@/lib/geo";
import { decodeLossYear } from "@/lib/server/land/forest";
import { lonLatToTile, tilePixelM, tileToLonLat } from "@/lib/server/land/plot";
import { loadDistricts, type DistrictShape } from "../districts";
import type { Adapter } from "./types";

/**
 * Tree cover lost per district per year since 2001, for the scorecards, from
 * Global Forest Watch's public tree cover loss tiles (Hansen/UMD/Google/USGS/
 * NASA, canopy of at least 30%). The tiles are read at zoom 12 (about 38 m
 * pixels over Ghana); on a test area this came within 3% of the total read at
 * the data's own 30 m. A district is computed once and refreshed after 180
 * days, when Global Forest Watch may have published a new year.
 */
const SLUG = "gfw-tree-cover-loss";
const Z = 12;
const FIRST_YEAR = 2001;
const LOSS_URL = (x: number, y: number) => `https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/${Z}/${x}/${y}.png?implementation=tcd_30`;
const STALE_DAYS = 180;

/** Year of loss minus 2000 for each pixel of a tile (0 = no loss), or null for an empty tile. */
type LossTile = Uint8Array | null;

export const forestLossAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 24,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    const budgetMs = Number(process.env.FOREST_LOSS_BUDGET_MINUTES ?? 20) * 60_000;
    const started = Date.now();
    const districts = await loadDistricts(db);
    const fresh = new Set(
      (
        await db
          .selectDistinct({ id: districtForestLoss.districtId })
          .from(districtForestLoss)
          .where(gte(districtForestLoss.computedAt, new Date(ctx.now.getTime() - STALE_DAYS * 86_400_000)))
      ).map((r) => r.id),
    );
    // West to east, so neighbouring districts reuse the same tiles.
    const todo = districts.filter((d) => !fresh.has(d.id)).sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
    const tiles = new Map<string, Promise<LossTile>>();
    const getTile = (x: number, y: number) => {
      const k = `${x}/${y}`;
      let p = tiles.get(k);
      if (!p) {
        p = loadTile(x, y);
        tiles.set(k, p);
        if (tiles.size > 600) tiles.delete(tiles.keys().next().value!);
      }
      return p;
    };
    let done = 0;
    let lastYear = 0;
    const notes: string[] = [];
    for (const d of todo) {
      if (Date.now() - started > budgetMs) break;
      try {
        const byYear = await districtLoss(d, getTile);
        const years = Object.keys(byYear).map(Number);
        lastYear = Math.max(lastYear, ...years);
        const last = Math.max(ctx.now.getUTCFullYear() - 1, lastYear);
        const rows = [];
        for (let y = FIRST_YEAR; y <= last; y++) rows.push({ districtId: d.id, year: y, lossHa: Math.round((byYear[y] ?? 0) * 10) / 10, computedAt: ctx.now });
        await db.delete(districtForestLoss).where(eq(districtForestLoss.districtId, d.id));
        await db.insert(districtForestLoss).values(rows);
        done++;
      } catch (e) {
        notes.push(`${d.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const [{ n }] = (await db.select({ n: sql<number>`count(distinct ${districtForestLoss.districtId})::int` }).from(districtForestLoss)) as Array<{ n: number }>;
    ctx.log(`${SLUG}: ${done} districts computed this run; ${n} of ${districts.length} have forest loss figures`);
    if (todo.length > done) notes.push(`${todo.length - done} districts left for the next run`);
    return { events: [], notes, extra: { computed: done, districtsWithFigures: Number(n), newestYear: lastYear || null } };
  },
};

/** Hectares of tree cover lost per year inside one district outline. */
export async function districtLoss(d: DistrictShape, getTile: (x: number, y: number) => Promise<LossTile>): Promise<Record<number, number>> {
  const [minLon, minLat, maxLon, maxLat] = d.bbox;
  const tl = lonLatToTile(minLon, maxLat, Z);
  const br = lonLatToTile(maxLon, minLat, Z);
  const byYear: Record<number, number> = {};
  const jobs: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(tl.x); x <= Math.floor(br.x); x++) for (let y = Math.floor(tl.y); y <= Math.floor(br.y); y++) jobs.push({ x, y });
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(
      jobs.slice(i, i + 8).map(async ({ x, y }) => {
        const tile = await getTile(x, y);
        if (!tile) return;
        for (let row = 0; row < 256; row++) {
          const lat = tileToLonLat(x, y + (row + 0.5) / 256, Z).lat;
          if (lat < minLat || lat > maxLat) continue;
          const areaHa = tilePixelM(Z, 256, lat) ** 2 / 10_000;
          for (let col = 0; col < 256; col++) {
            const v = tile[row * 256 + col];
            if (!v) continue;
            const lon = tileToLonLat(x + (col + 0.5) / 256, y, Z).lon;
            if (lon < minLon || lon > maxLon || !pointInPolygon([lon, lat], d.geom)) continue;
            byYear[2000 + v] = (byYear[2000 + v] ?? 0) + areaHa;
          }
        }
      }),
    );
  }
  return byYear;
}

const USER_AGENT = "GhanaWatch/0.1 (environmental monitoring)";

async function loadTile(x: number, y: number): Promise<LossTile> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(LOSS_URL(x, y), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sharp = (await import("sharp")).default;
      const { data } = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const out = new Uint8Array(256 * 256);
      let any = false;
      for (let i = 0; i < out.length; i++) {
        const year = decodeLossYear(data[i * 4], data[i * 4 + 2]);
        if (year) {
          out[i] = year - 2000;
          any = true;
        }
      }
      return any ? out : null;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}
