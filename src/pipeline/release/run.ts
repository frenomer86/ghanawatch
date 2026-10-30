import { config as loadEnv } from "dotenv";
import { closeDb, migrateDb } from "@/lib/db/client";
import { monthOf, previousMonth } from "@/lib/domain/index";
import { runRelease } from "@/lib/server/release/run";

/**
 * `npm run release -- [--month=YYYY-MM] [--dry-run] [--skip-sample] [--force]`
 *
 * The monthly release: closes the index, writes public/releases/{month}/ (data files, PDF, press
 * release, cards, manifest), appends the changelog, records the release and deposits on Zenodo when a
 * token is set. Default month: last month. --dry-run writes to DATA_DIR/releases-staging/{month}/ and
 * records nothing public. The release refuses to publish while the confirmation sample has unchecked sites
 * unless --skip-sample is given, and refuses to re-release a published month unless --force is given.
 */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const month = arg("month") ?? previousMonth(monthOf(new Date()));
  await migrateDb();
  const r = await runRelease({
    month,
    dryRun: process.argv.includes("--dry-run"),
    skipSample: process.argv.includes("--skip-sample"),
    force: process.argv.includes("--force"),
    log: (s) => console.log(`[release] ${s}`),
  });
  console.log(`[release] ${r.dryRun ? "dry run" : "published"} ${r.month}: ${r.files.length} files in ${r.dir}${r.doi ? `, DOI ${r.doi}` : ""}`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
