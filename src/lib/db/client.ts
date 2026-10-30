import path from "node:path";
import fs from "node:fs";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/server/env";

export type Db = PgliteDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

/**
 * One database handle per process.
 *
 * - DATABASE_URL set   → Postgres via postgres.js (Neon, Supabase, RDS, self-hosted).
 *   Migrations are NOT run per request: `npm run db:migrate` (or `npm run setup`)
 *   applies them once per deploy, and the seed and pipeline scripts call
 *   migrateDb() themselves. Serverless functions keep a tiny pool (DB_POOL_MAX,
 *   default 3) and disable prepared statements so a PgBouncer-style pooler works.
 * - DATABASE_URL empty → PGlite, an embedded Postgres persisted under DATA_DIR/pglite,
 *   migrated on open (local development only).
 *
 * Both run the same Drizzle schema and the same SQL migrations from ./drizzle.
 * The handle is cached on globalThis so Next.js hot reloads do not open a new
 * connection per compile.
 */
type Cache = { db?: Db; ready?: Promise<Db> };
const g = globalThis as unknown as { __ghanawatchDb?: Cache };
const cache: Cache = (g.__ghanawatchDb ??= {});

const migrationsFolder = path.join(process.cwd(), "drizzle");

async function open(): Promise<Db> {
  const e = env();
  if (e.DATABASE_URL) {
    const client = postgres(e.DATABASE_URL, {
      max: e.DB_POOL_MAX,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false,
      ssl: /sslmode=(require|verify)/.test(e.DATABASE_URL) || /neon.tech|supabase.co/.test(e.DATABASE_URL) ? "require" : undefined,
    });
    return drizzlePostgres(client, { schema, casing: "snake_case" });
  }
  const dir = path.join(process.cwd(), e.DATA_DIR, "pglite");
  fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzlePglite(client, { schema, casing: "snake_case" });
  await migratePglite(db, { migrationsFolder });
  return db;
}

export function getDb(): Promise<Db> {
  if (cache.db) return Promise.resolve(cache.db);
  if (!cache.ready) {
    cache.ready = open().then((db) => {
      cache.db = db;
      return db;
    });
    cache.ready.catch(() => {
      cache.ready = undefined;
    });
  }
  return cache.ready;
}

/** Apply pending SQL migrations. Idempotent; used by scripts and `npm run db:migrate`. */
export async function migrateDb(): Promise<void> {
  const db = await getDb();
  if (env().DATABASE_URL) await migratePostgres(db as PostgresJsDatabase<typeof schema>, { migrationsFolder });
  // PGlite was already migrated when it was opened.
}

/** Close the connection pool so one-off scripts exit promptly. */
export async function closeDb(): Promise<void> {
  const db = cache.db as unknown as { $client?: { end?: () => Promise<void>; close?: () => Promise<void> } } | undefined;
  await db?.$client?.end?.();
  await db?.$client?.close?.();
  cache.db = undefined;
  cache.ready = undefined;
}

/** Normalise db.execute() results: postgres.js returns an array, PGlite returns { rows }. */
export function rows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = res as { rows?: T[] };
  return r.rows ?? [];
}

export { schema };
