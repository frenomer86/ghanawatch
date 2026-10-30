import { FIRST_MOSAIC_YEAR, annualMosaicTiles } from "@/lib/explore/imagery";
import { TtlCache } from "./cache";
import { userAgent } from "./fetch";

/**
 * Years for which EOX has published a Sentinel-2 cloudless mosaic. A new year
 * appears without a code change: each candidate year is probed once a day.
 */
const cache = new TtlCache<number[]>(1, 24 * 3_600_000);

export async function annualYears(now = new Date()): Promise<number[]> {
  return cache.get("years", async () => {
    const years: number[] = [];
    for (let y = FIRST_MOSAIC_YEAR; y <= now.getUTCFullYear(); y++) years.push(y);
    const ok = await Promise.all(
      years.map(async (y) => {
        try {
          const url = annualMosaicTiles(y).replace("{z}", "0").replace("{y}", "0").replace("{x}", "0");
          const res = await fetch(url, { method: "HEAD", headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(6_000) });
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    const found = years.filter((_, i) => ok[i]);
    if (!found.length) throw new Error("EOX mosaics unreachable");
    return found;
  });
}
