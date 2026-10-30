import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { changeEvents, imageReferences } from "@/lib/db/schema";
import { ALLOWED_COG_PREFIX, makeGrid, readVisual, withRetry } from "@/pipeline/s2/cog";
import { epsgFromCogUrl, toProj } from "@/pipeline/s2/process";
import { S1_COG_PREFIX, dbToGrey, radarEpsg, readRadarDb, sasToken } from "@/pipeline/s1/pc";

/**
 * The true-colour Sentinel-2 view of a detection (radar backscatter in grey for radar ponds), cropped to
 * the site plus a margin, as a 512 px JPEG with the outline drawn on the after view. Read straight from
 * the public Cloud-Optimized GeoTIFF recorded with the event; only the Sentinel-2 open-data bucket and the
 * Planetary Computer Sentinel-1 store are ever fetched. Shared by the image route, the release PDF and
 * the evidence pages.
 */
const cache = new Map<string, Buffer>();

export async function renderEventImage(eventId: string, role: "latest" | "before"): Promise<Buffer | null> {
  const key = `${eventId}:${role}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const db = await getDb();
  const [row] = await db
    .select({ href: imageReferences.tileUrlTemplate, e: changeEvents })
    .from(imageReferences)
    .innerJoin(changeEvents, eq(changeEvents.id, imageReferences.changeEventId))
    .where(and(eq(imageReferences.changeEventId, eventId), eq(imageReferences.role, role)))
    .limit(1);
  const isRadar = Boolean(row?.href?.startsWith(S1_COG_PREFIX));
  if (!row?.href || (!row.href.startsWith(ALLOWED_COG_PREFIX) && !isRadar)) return null;
  const e = row.e;
  const sas = isRadar ? await sasToken((url) => fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json())) : "";
  const epsg = isRadar ? await radarEpsg(row.href, sas) : epsgFromCogUrl(row.href);
  const toUtm = (lon: number, lat: number) => toProj(epsg, lon, lat);
  const [x0, y0] = toUtm(e.bboxMinLon ?? 0, e.bboxMinLat ?? 0);
  const [x1, y1] = toUtm(e.bboxMaxLon ?? 0, e.bboxMaxLat ?? 0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const half = Math.min(4000, Math.max(800, Math.max(x1 - x0, y1 - y0) * 0.9));
  const grid = makeGrid([cx - half, cy - half, cx + half, cy + half], 10);
  const rgb = isRadar ? null : await withRetry(() => readVisual(row.href!, grid));
  const grey = isRadar ? dbToGrey(await withRetry(() => readRadarDb(row.href!, sas, grid))) : null;

  const ring = (e.geom?.type === "Polygon" ? e.geom.coordinates[0] : []) as number[][];
  const pts = ring
    .map(([lon, lat]) => {
      const [x, y] = toUtm(lon, lat);
      return `${(((x - grid.bbox[0]) / grid.res) * 512) / grid.width},${(((grid.bbox[3] - y) / grid.res) * 512) / grid.height}`;
    })
    .join(" ");
  const outline = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><polygon points="${pts}" fill="none" stroke="#ffd400" stroke-width="2.5" stroke-dasharray="6 4"/></svg>`);
  const sharp = (await import("sharp")).default;
  const base = rgb
    ? sharp(Buffer.from(rgb), { raw: { width: grid.width, height: grid.height, channels: 3 } }).resize(512, 512).modulate({ brightness: 1.25 })
    : sharp(Buffer.from(grey!), { raw: { width: grid.width, height: grid.height, channels: 1 } }).resize(512, 512).toColourspace("srgb");
  const jpeg = await base
    .composite(role === "latest" && pts ? [{ input: outline }] : [])
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  cache.set(key, jpeg);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return jpeg;
}
