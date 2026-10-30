import { config as loadEnv } from "dotenv";
import { closeDb, migrateDb } from "@/lib/db/client";
import { monthOf, previousMonth } from "@/lib/domain/index";
import { closeMonth } from "@/lib/server/index/close";

/**
 * `npm run index:close -- [--month=YYYY-MM] [--dry-run] [--reprocess]`
 *
 * Freezes the Galamsey Index for the month (default: last month) and every earlier month still open.
 * --dry-run computes and reports without writing. --reprocess rewrites months already closed under the
 * current index version; use it only after a corrections entry explains why.
 */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const month = arg("month") ?? previousMonth(monthOf(new Date()));
  const dryRun = process.argv.includes("--dry-run");
  const reprocess = process.argv.includes("--reprocess");
  await migrateDb();
  const r = await closeMonth(month, { dryRun, reprocess, log: (s) => console.log(`[index] ${s}`) });
  console.log(`[index] ${r.dryRun ? "dry run" : "closed"} ${r.month} (version ${r.version}): ${r.national.newHa} ha new, ${r.national.cumHa} ha cumulative, ${r.national.districtsAffected} districts`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
