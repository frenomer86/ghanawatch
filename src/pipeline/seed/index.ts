import { config as loadEnv } from "dotenv";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, migrateDb } from "@/lib/db/client";
import { adminBoundaries, changeEvents, contextFeatures, dataSources, hotspots, pipelineRuns, users } from "@/lib/db/schema";
import { uuidv7 } from "@/lib/server/ids";
import { env } from "@/lib/server/env";
import { seedBoundaries } from "./boundaries";
import { seedSources, sourceId } from "./sources";
import { SOURCE_REGISTRY } from "../sources";
import { loadOsmContext, loadOsmMines, loadOsmWaterways } from "../context/osm";
import { loadRiverLines, riverLinesFresh } from "../s1/rivers";
import { seedCells } from "../s2/cells";
import { seedIntakes } from "@/lib/server/index/intakes";

/**
 * `npm run seed` — loads district and region boundaries and the source
 * registry, removes any non-live records, and creates the administrator.
 * It never creates detections; those come only from `npm run pipeline`.
 * Safe to re-run.
 */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const log = (s: string) => console.log(`[seed] ${s}`);
  await migrateDb();
  const db = await getDb();

  await seedSources(db, log);
  await seedBoundaries(db, log);
  await purgeNonLiveData(db, log);
  await refreshContext(db, log);
  await refreshRivers(db, log);
  await ensureWaterways(db, log);
  await seedCells(db, log);
  await seedIntakes(log);
  await seedAdmin(db, log);

  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(changeEvents)) as Array<{ n: number }>;
  const [{ d }] = (await db.select({ d: sql<number>`count(*)::int` }).from(adminBoundaries)) as Array<{ d: number }>;
  log(`done: ${d} boundaries, ${n} detections (detections come only from live sources: run npm run pipeline)`);
}

/** Refresh OpenStreetMap context when it is missing or older than 30 days. */
async function refreshContext(db: Awaited<ReturnType<typeof getDb>>, log: (s: string) => void) {
  const [row] = (await db
    .select({ n: sql<number>`count(*)::int`, at: sql<string | null>`max(${contextFeatures.updatedAt})` })
    .from(contextFeatures)) as Array<{ n: number; at: string | null }>;
  const fresh = row && row.n > 1000 && row.at && Date.now() - new Date(row.at).getTime() < 30 * 86_400_000;
  if (fresh && !process.argv.includes("--refresh-context")) {
    log(`osm context: ${row.n} features, refreshed ${row.at}`);
    await ensureMines(db, log);
    return;
  }
  try {
    await loadOsmContext(db, fetchText, log);
  } catch (err) {
    log(`osm context: refresh failed (${err instanceof Error ? err.message : String(err)}); keeping ${row?.n ?? 0} existing features`);
  }
}

/** Named mines joined the context after its first load; fetch them on their own when missing. */
async function ensureMines(db: Awaited<ReturnType<typeof getDb>>, log: (s: string) => void) {
  const [m] = (await db.select({ n: sql<number>`count(*)::int` }).from(contextFeatures).where(eq(contextFeatures.kind, "mine"))) as Array<{ n: number }>;
  if (m && m.n > 0) return;
  try {
    await loadOsmMines(db, fetchText, log);
  } catch (err) {
    log(`osm mines: refresh failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Rivers, drains and wetlands for the Floods section, when missing (a large Overpass query, a few minutes). */
async function ensureWaterways(db: Awaited<ReturnType<typeof getDb>>, log: (s: string) => void) {
  const [w] = (await db.select({ n: sql<number>`count(*)::int` }).from(contextFeatures).where(eq(contextFeatures.kind, "waterway"))) as Array<{ n: number }>;
  if (w && w.n > 0) return;
  try {
    await loadOsmWaterways(db, fetchText, log);
  } catch (err) {
    log(`osm waterways: load failed (${err instanceof Error ? err.message : String(err)}); run src/pipeline/seed/waterways.ts later`);
  }
}

/** The rivers radar watches for dredgers, when missing or older than 30 days. */
async function refreshRivers(db: Awaited<ReturnType<typeof getDb>>, log: (s: string) => void) {
  if ((await riverLinesFresh(db)) && !process.argv.includes("--refresh-context")) return;
  try {
    await loadRiverLines(db, fetchText, log);
  } catch (err) {
    log(`rivers: refresh failed (${err instanceof Error ? err.message : String(err)}); the radar adapter retries on its next run`);
  }
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { ...init, headers: { "user-agent": "GhanaWatch/0.1 (environmental monitoring)", ...(init?.headers ?? {}) } });
    if (res.ok) return res.text();
    if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 20_000 * (i + 1)));
  }
  throw new Error("Overpass unavailable");
}

/**
 * GhanaWatch shows live data only. Removes any detection whose source is not
 * in the live registry, and any record produced from bundled sample files by
 * earlier development builds.
 */
async function purgeNonLiveData(db: Awaited<ReturnType<typeof getDb>>, log: (s: string) => void) {
  const liveIds = SOURCE_REGISTRY.map((s) => sourceId(s.slug));
  const strayEvents = await db.delete(changeEvents).where(sql`${changeEvents.sourceId} not in ${liveIds}`).returning();
  const sampleEvents = await db
    .delete(changeEvents)
    .where(sql`(${changeEvents.properties} ->> 'fixture') = 'true' or (${changeEvents.properties} ->> 'synthetic') = 'true'`)
    .returning();
  await db.delete(changeEvents).where(sql`${changeEvents.methodVersion} = 's2-galamsey-1.0'`);
  await db.delete(pipelineRuns).where(sql`${pipelineRuns.sourceId} not in ${liveIds} or ${pipelineRuns.error} like 'fixture%'`);
  await db.delete(dataSources).where(sql`${dataSources.id} not in ${liveIds}`);
  await db.delete(hotspots);
  log(`purge: removed ${strayEvents.length + sampleEvents.length} non-live detections`);
}

async function seedAdmin(db: Awaited<ReturnType<typeof getDb>>, log: (s: string) => void) {
  const e = env();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (existing.length) {
    log("admin: already present");
    return;
  }
  if (!e.ADMIN_INITIAL_PASSWORD) {
    log("admin: skipped (set ADMIN_INITIAL_PASSWORD in .env.local to create the first administrator)");
    return;
  }
  const { hash } = await import("@node-rs/argon2");
  const passwordHash = await hash(e.ADMIN_INITIAL_PASSWORD, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
  await db.insert(users).values({
    id: uuidv7(),
    email: e.ADMIN_EMAIL,
    displayName: "Administrator",
    role: "admin",
    passwordHash,
    mustChangePassword: true,
    emailVerifiedAt: new Date(),
  });
  log(`admin: created ${e.ADMIN_EMAIL} (password change required at first login)`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
