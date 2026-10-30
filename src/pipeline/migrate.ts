import { config as loadEnv } from "dotenv";
import { closeDb, migrateDb } from "@/lib/db/client";

/** `npm run db:migrate` — apply pending SQL migrations from ./drizzle to DATABASE_URL (or local PGlite). */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const target = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "local PGlite";
  console.log(`[migrate] applying migrations to ${target}`);
  await migrateDb();
  await closeDb();
  console.log("[migrate] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
