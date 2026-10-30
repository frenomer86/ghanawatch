import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, migrateDb } from "@/lib/db/client";
import { publishDigest } from "@/lib/server/alerts/digest";

/**
 * `npm run alerts:weekly -- [--week-ending=YYYY-MM-DD]`
 *
 * Builds the weekly digest of likely galamsey sites first seen in the last seven days, records it,
 * emails confirmed subscribers (when BREVO_API_KEY is set) and writes the WhatsApp post to
 * public/alerts/latest.txt for the channel. Runs every Monday at 07:00 GMT from the scheduler; safe to
 * re-run, a week is never published twice.
 */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const weekEnding = arg("week-ending") ? new Date(`${arg("week-ending")}T00:00:00Z`) : new Date();
  await migrateDb();
  const log = (s: string) => console.log(`[alerts] ${s}`);
  const { digest, emails, created } = await publishDigest(weekEnding, log);
  const dir = join(process.cwd(), "public", "alerts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest.txt"), digest.text);
  writeFileSync(join(dir, `${digest.weekEnding}.txt`), digest.text);
  log(`${created ? "published" : "already published"} week ending ${digest.weekEnding}: ${digest.newSites} sites in ${digest.districts.length} districts, ${emails} emails; WhatsApp text at public/alerts/latest.txt`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
