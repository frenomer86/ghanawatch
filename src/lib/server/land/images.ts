import { annualMosaicTiles, waybackTiles } from "@/lib/explore/imagery";
import { userAgent } from "@/lib/server/explore/fetch";
import { lonLatToTile, type Plot } from "./plot";

/**
 * Still pictures of a plot for the land report and its PDF: tiles from a
 * dated imagery layer stitched into one square, with the plot outlined. The
 * caller says which layer, and the report prints its date and credit.
 */
const SIZE = 640;

export type ImageLayer = { kind: "mosaic"; year: number } | { kind: "closeup"; release: number };

function tileUrl(layer: ImageLayer, z: number, x: number, y: number) {
  const t = layer.kind === "mosaic" ? annualMosaicTiles(layer.year) : waybackTiles(layer.release);
  return t.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

export async function plotImage(plot: Plot, layer: ImageLayer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  // A square view about twice the plot's size, centred on it.
  const [minLon, minLat, maxLon, maxLat] = plot.bbox;
  const halfLon = ((maxLon - minLon) / 2) * 2.1;
  const halfLat = ((maxLat - minLat) / 2) * 2.1;
  const view = { west: plot.center.lon - halfLon, east: plot.center.lon + halfLon, north: plot.center.lat + halfLat, south: plot.center.lat - halfLat };

  // Deepest zoom at which the view still fits in about two picture widths of tiles.
  const maxZ = layer.kind === "mosaic" ? 15 : 18;
  let z = maxZ;
  for (; z > 8; z--) {
    const a = lonLatToTile(view.west, view.north, z);
    const b = lonLatToTile(view.east, view.south, z);
    if ((b.x - a.x) * 256 <= SIZE * 2) break;
  }
  const a = lonLatToTile(view.west, view.north, z);
  const b = lonLatToTile(view.east, view.south, z);
  const x0 = Math.floor(a.x);
  const y0 = Math.floor(a.y);
  const x1 = Math.floor(b.x);
  const y1 = Math.floor(b.y);
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;

  const tiles = await Promise.all(
    Array.from({ length: cols * rows }, async (_, i) => {
      const x = x0 + (i % cols);
      const y = y0 + Math.floor(i / cols);
      try {
        const res = await fetch(tileUrl(layer, z, x, y), { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const input = await sharp(Buffer.from(await res.arrayBuffer())).resize(256, 256).png().toBuffer();
        return { input, left: (x - x0) * 256, top: (y - y0) * 256 };
      } catch {
        return null;
      }
    }),
  );
  const mosaic = await sharp({ create: { width: cols * 256, height: rows * 256, channels: 3, background: "#0b2e23" } })
    .composite(tiles.filter((t): t is NonNullable<typeof t> => t !== null))
    .png()
    .toBuffer();

  // Crop to the view, then draw the plot outline in the cropped pixel space.
  const left = Math.round((a.x - x0) * 256);
  const top = Math.round((a.y - y0) * 256);
  const width = Math.max(1, Math.round((b.x - a.x) * 256));
  const height = Math.max(1, Math.round((b.y - a.y) * 256));
  const px = (lon: number, lat: number) => {
    const t = lonLatToTile(lon, lat, z);
    return [((t.x - a.x) * 256 * SIZE) / width, ((t.y - a.y) * 256 * SIZE) / height];
  };
  const points = plot.ring.map(([lon, lat]) => px(lon, lat).map((v) => v.toFixed(1)).join(",")).join(" ");
  const outline = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><polygon points="${points}" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="5"/><polygon points="${points}" fill="none" stroke="#ffd400" stroke-width="2.5" stroke-dasharray="8 5"/></svg>`,
  );
  return sharp(mosaic)
    .extract({ left, top, width: Math.min(width, cols * 256 - left), height: Math.min(height, rows * 256 - top) })
    .resize(SIZE, SIZE, { fit: "fill" })
    .composite([{ input: outline }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}
