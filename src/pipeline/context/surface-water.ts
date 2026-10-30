/**
 * Where open water has been seen before, from the JRC Global Surface Water
 * occurrence layer: the share of all Landsat observations from 1984 to 2021
 * in which each 30 m pixel was water, published as keyless public tiles.
 *
 * Lake Volta's shores, reservoirs drawn down in the dry season and river
 * floodplains fill and empty with the seasons. New water there, or green
 * shoreline that is flooded now, is not a new mining pit, so the detectors
 * skip pixels that were water in at least WATER_SEEN_PCT of past observations.
 * Pits dug before 2021 that held water count too; they are not new either.
 */
export const GSW_TILES = (z: number, x: number, y: number) => `https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/${z}/${x}/${y}.png`;
export const GSW_ZOOM = 13; // finest zoom served (about 19 m pixels in Ghana; the data is 30 m)
export const WATER_SEEN_PCT = 10;
export const GSW_CREDIT = "JRC Global Surface Water 1984–2021 (EC JRC / Google)";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** What the detectors need: how often a point was water in the past (0–100). */
export interface WaterSeen {
  occurrence(lon: number, lat: number): Promise<number>;
}
/** Occurrence 0–100 per pixel of a 256 px tile; null when the tile holds no water at all. */
type Tile = Uint8Array | null;

export class SurfaceWater implements WaterSeen {
  private tiles = new Map<string, Promise<Tile>>();
  failed = 0;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly userAgent = "GhanaWatch/0.1 (environmental monitoring)",
    private readonly maxTiles = 2000,
  ) {}

  /** Percentage of past observations (1984–2021) in which this point was water. */
  async occurrence(lon: number, lat: number): Promise<number> {
    const n = 2 ** GSW_ZOOM;
    const fx = ((lon + 180) / 360) * n;
    const r = (lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const tile = await this.tile(x, y);
    if (!tile) return 0;
    const px = Math.min(255, Math.floor((fx - x) * 256));
    const py = Math.min(255, Math.floor((fy - y) * 256));
    return tile[py * 256 + px];
  }

  /** Share (0–1) of the points that were water in at least `minPct` of past observations. */
  async shareSeen(points: Array<[number, number]>, minPct = WATER_SEEN_PCT): Promise<number> {
    if (!points.length) return 0;
    let wet = 0;
    for (const [lon, lat] of points) if ((await this.occurrence(lon, lat)) >= minPct) wet++;
    return wet / points.length;
  }

  private tile(x: number, y: number): Promise<Tile> {
    const key = `${x}/${y}`;
    let p = this.tiles.get(key);
    if (!p) {
      p = this.load(x, y);
      this.tiles.set(key, p);
      if (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return p;
  }

  private async load(x: number, y: number): Promise<Tile> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetcher(GSW_TILES(GSW_ZOOM, x, y), { headers: { "user-agent": this.userAgent }, signal: AbortSignal.timeout(20_000) });
        if (res.status === 404) return null; // no water anywhere in this tile
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return decodeOccurrence(Buffer.from(await res.arrayBuffer()));
      } catch {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // Unknown is treated as dry: a failed tile must never hide a detection.
    this.failed++;
    return null;
  }
}

/**
 * The occurrence tiles colour each pixel from red (rarely water) to blue
 * (always water), with blue = occurrence × 2.55 and alpha 0 where water was
 * never seen.
 */
export async function decodeOccurrence(png: Buffer): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(256 * 256);
  for (let i = 0, p = 0; i < info.width * info.height && p < out.length; i++, p++) {
    const o = i * 4;
    out[p] = data[o + 3] === 0 ? 0 : Math.min(100, Math.round(data[o + 2] / 2.55));
  }
  return out;
}
