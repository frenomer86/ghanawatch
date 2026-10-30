import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { machinerySightings, radarTargets } from "@/lib/db/schema";
import { SESSION_COOKIE, sessionFromToken } from "@/lib/server/auth";
import { enforceRateLimit, handle, HttpError, parseQuery } from "@/lib/server/http";
import { makeGrid } from "@/pipeline/s2/cog";
import { toProj } from "@/pipeline/s2/process";
import { S1_COG_PREFIX, dbToGrey, radarEpsg, readRadarDb, sasToken } from "@/pipeline/s1/pc";

/**
 * GET /api/v1/radar/target?sighting=<id>
 * The Sentinel-1 radar picture (VV, 10 m, about 1.2 km across) around a river
 * reflection the radar flagged, with the spot marked, for the moderator who
 * checks it. Public once the tag is confirmed.
 */
const query = z.object({ sighting: z.string().uuid() }).strict();
const cache = new Map<string, Buffer>();

export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, query);
  const db = await getDb();
  const [sighting] = await db.select({ status: machinerySightings.status }).from(machinerySightings).where(eq(machinerySightings.id, q.sighting)).limit(1);
  if (!sighting) throw new HttpError(404, "Not found");
  if (sighting.status !== "confirmed") {
    const user = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
    if ((user?.role !== "moderator" && user?.role !== "admin") || !user.twoFactor) throw new HttpError(404, "Not found");
  }
  let jpeg = cache.get(q.sighting);
  if (!jpeg) {
    const [target] = await db.select().from(radarTargets).where(eq(radarTargets.sightingId, q.sighting)).orderBy(desc(radarTargets.acqDate)).limit(1);
    if (!target) throw new HttpError(404, "No radar pass for this tag");
    const fetchJson = <T,>(url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<T>);
    const found = await fetchJson<{ features?: Array<{ assets: Record<string, { href: string }> }> }>("https://planetarycomputer.microsoft.com/api/stac/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collections: ["sentinel-1-rtc"], ids: [target.sceneId], limit: 1 }),
    });
    const href = found.features?.[0]?.assets.vv?.href;
    if (!href?.startsWith(S1_COG_PREFIX)) throw new HttpError(404, "Radar pass not available");
    const sas = await sasToken(fetchJson);
    const epsg = await radarEpsg(href, sas);
    const [x, y] = toProj(epsg, target.lon, target.lat);
    const grid = makeGrid([x - 600, y - 600, x + 600, y + 600], 10);
    const grey = dbToGrey(await readRadarDb(href, sas, grid));
    const size = 480;
    const px = ((x - grid.bbox[0]) / grid.res) * (size / grid.width);
    const py = ((grid.bbox[3] - y) / grid.res) * (size / grid.height);
    const mark = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${px}" cy="${py}" r="18" fill="none" stroke="#f43f5e" stroke-width="3"/><text x="8" y="${size - 10}" font-family="sans-serif" font-size="14" fill="#fff" stroke="#000" stroke-width="0.6">Sentinel-1 VV ${target.acqDate}</text></svg>`,
    );
    const sharp = (await import("sharp")).default;
    jpeg = await sharp(Buffer.from(grey), { raw: { width: grid.width, height: grid.height, channels: 1 } })
      .resize(size, size, { kernel: "nearest" })
      .toColourspace("srgb")
      .composite([{ input: mark }])
      .jpeg({ quality: 82 })
      .toBuffer();
    cache.set(q.sighting, jpeg);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return new Response(new Uint8Array(jpeg), {
    headers: { "content-type": "image/jpeg", "cache-control": sighting.status === "confirmed" ? "public, max-age=86400" : "private, no-store", "x-content-type-options": "nosniff" },
  });
});
