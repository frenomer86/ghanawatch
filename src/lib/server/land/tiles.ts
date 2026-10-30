import { userAgent } from "@/lib/server/explore/fetch";
import { lonLatToTile, pointInRing, tilePixelM, tileToLonLat, type Plot } from "./plot";

/**
 * Read data-encoded map tiles (Global Forest Watch publishes forest loss and
 * deforestation alerts as PNG tiles whose colour channels carry the year or
 * the date) and visit every pixel whose centre lies inside the plot.
 */
export interface TileSampleResult {
  tiles: number;
  failed: number;
  /** Address the tile server finally answered from, which carries the dataset version. */
  finalUrl: string | null;
}

export async function samplePlotTiles(
  urlFor: (z: number, x: number, y: number) => string,
  z: number,
  plot: Plot,
  onPixel: (r: number, g: number, b: number, a: number, areaM2: number) => void,
): Promise<TileSampleResult> {
  const [minLon, minLat, maxLon, maxLat] = plot.bbox;
  const tl = lonLatToTile(minLon, maxLat, z);
  const br = lonLatToTile(maxLon, minLat, z);
  const jobs: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(tl.x); x <= Math.floor(br.x); x++) for (let y = Math.floor(tl.y); y <= Math.floor(br.y); y++) jobs.push({ x, y });
  if (jobs.length > 16) throw new Error("plot too large for tile sampling");

  const sharp = (await import("sharp")).default;
  let failed = 0;
  let finalUrl: string | null = null;
  await Promise.all(
    jobs.map(async ({ x, y }) => {
      try {
        const res = await fetch(urlFor(z, x, y), { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) return; // no data in this tile
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        finalUrl ??= res.url;
        const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const size = info.width;
        const areaM2 = tilePixelM(z, size, plot.center.lat) ** 2;
        const lons = Array.from({ length: size }, (_, i) => tileToLonLat(x + (i + 0.5) / size, y, z).lon);
        for (let row = 0; row < info.height; row++) {
          const lat = tileToLonLat(x, y + (row + 0.5) / info.height, z).lat;
          if (lat < minLat || lat > maxLat) continue;
          for (let col = 0; col < size; col++) {
            const lon = lons[col];
            if (lon < minLon || lon > maxLon || !pointInRing(lon, lat, plot.ring)) continue;
            const o = (row * size + col) * 4;
            onPixel(data[o], data[o + 1], data[o + 2], data[o + 3], areaM2);
          }
        }
      } catch {
        failed++;
      }
    }),
  );
  return { tiles: jobs.length, failed, finalUrl };
}
