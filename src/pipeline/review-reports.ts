import { config as loadEnv } from "dotenv";
import { closeDb } from "@/lib/db/client";
import { reviewDue } from "@/lib/server/reports/auto-review";
import { safetySession } from "@/lib/server/reports/image-safety";

/**
 * `npm run reports:review -- [--watch] [--every=60]`
 *
 * The report reviewer (src/lib/server/reports/auto-review.ts): screens the photo of every new citizen report,
 * blurs faces, and publishes or rejects the report on the evidence without a moderator; reports with no
 * evidence yet are held and checked again as new satellite passes arrive. With --watch it runs as the
 * `reviewer` service, looking for work every minute. It uses the website's limited database account (rows
 * only) and never runs migrations.
 */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const watch = process.argv.includes("--watch");
  const every = Number(process.argv.find((a) => a.startsWith("--every="))?.slice(8) ?? 60);
  const log = (s: string) => console.log(`[reviewer] ${new Date().toISOString()} ${s}`);
  // Fetch the photo safety model (88.5 MB, once) while the first reports are read.
  safetySession().then(
    () => log("photo safety model ready"),
    (e) => log(`photo safety model not ready (${e instanceof Error ? e.message : e}); reports wait until it is`),
  );
  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stop = true));
  do {
    const t = await reviewDue(new Date());
    const n = Object.values(t).reduce((a, b) => a + b, 0);
    if (n) log(`approved ${t.approve}, rejected ${t.reject}, held ${t.hold}, closed unverified ${t.expire}, skipped ${t.skipped}, failed ${t.failed}`);
    for (let i = 0; watch && !stop && i < every; i++) await new Promise((r) => setTimeout(r, 1000));
  } while (watch && !stop);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
