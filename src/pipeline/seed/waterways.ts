import { config as loadEnv } from "dotenv";
import { closeDb, getDb, migrateDb } from "@/lib/db/client";
import { loadOsmWaterways } from "../context/osm";

/**
 * \`npx tsx src/pipeline/seed/waterways.ts\`: load Ghana's rivers, canals, drains and wetlands from
 * OpenStreetMap for the Floods section. The country-wide query takes a few minutes.
 */
async function main() {
  loadEnv({ path: ".env.local" });
  loadEnv();
  await migrateDb();
  const db = await getDb();
  const fetchText = async (url: string, init?: RequestInit) => {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(900_000), headers: { "user-agent": "GhanaWatch/0.1", ...(init?.headers ?? {}) } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (e) {
        if (i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  };
  await loadOsmWaterways(db, fetchText, (s) => console.log(`[waterways] ${s}`));
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
