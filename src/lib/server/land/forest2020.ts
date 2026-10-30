import { fromUrl, type GeoTIFF } from "geotiff";
import type { Plot } from "./plot";

/**
 * Forest on 31 December 2020 under the EU's own reference map for the deforestation rule (EUDR): the JRC
 * Global Forest Cover 2020 map, 10 m, read straight from the Commission's public download (no key; CC BY
 * 4.0, © European Union). Only the rows covering the plot are fetched.
 */
const BASE = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/FOREST/GFC2020/LATEST/tiles/";
export const GFC2020_VERSION = "JRC GFC2020 V4";
const ROWS = 12;

const files = new Map<string, Promise<GeoTIFF>>();

/** The 10° tile holding a point; tiles are named by their north-west corner. */
function tileName(lon: number, lat: number): string {
  const n = Math.floor(lat / 10) * 10 + 10;
  const w = Math.floor(lon / 10) * 10;
  return `JRC_GFC2020_V4_N${n}_${w < 0 ? `W${-w}` : `E${w}`}.tif`;
}

function open(name: string): Promise<GeoTIFF> {
  let f = files.get(name);
  if (!f) {
    f = fromUrl(BASE + name);
    f.catch(() => files.delete(name));
    files.set(name, f);
  }
  return f;
}

export interface Forest2020 {
  forestHa: number;
  share: number;
  version: string;
}

export async function forest2020(plot: Plot): Promise<Forest2020> {
  const { lon, lat } = plot.center;
  const tiff = await open(tileName(lon, lat));
  const img = await tiff.getImage();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution(); // ry is negative
  const [w, s, e, n] = plot.bbox;
  const c0 = Math.max(0, Math.floor((w - ox) / rx));
  const c1 = Math.min(img.getWidth(), Math.ceil((e - ox) / rx));
  const r0 = Math.max(0, Math.floor((n - oy) / ry));
  const r1 = Math.min(img.getHeight(), Math.ceil((s - oy) / ry));
  const width = c1 - c0;
  // The file is stored one row per strip; asking for every row at once opens too many connections, so read
  // a few rows at a time, retrying a dropped connection.
  const raster = new Uint8Array(width * (r1 - r0));
  for (let r = r0; r < r1; r += ROWS) {
    const end = Math.min(r1, r + ROWS);
    for (let attempt = 0; ; attempt++) {
      try {
        const part = (await img.readRasters({ window: [c0, r, c1, end], samples: [0] }))[0] as Uint8Array;
        raster.set(part, (r - r0) * width);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
  }
  const mPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const pxHa = (Math.abs(rx) * mPerLon * Math.abs(ry) * 110_574) / 10_000;
  let inside = 0;
  let forest = 0;
  for (let r = 0; r < r1 - r0; r++) {
    const py = oy + (r0 + r + 0.5) * ry;
    for (let c = 0; c < width; c++) {
      const px = ox + (c0 + c + 0.5) * rx;
      if (Math.hypot((px - lon) * mPerLon, (py - lat) * 110_574) > plot.radiusM) continue;
      inside++;
      if (raster[r * width + c] === 1) forest++;
    }
  }
  return { forestHa: Math.round(forest * pxHa * 100) / 100, share: inside ? forest / inside : 0, version: GFC2020_VERSION };
}
