import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGrid, readVisual, withRetry } from "./cog";
import { epsgFromCogUrl, toProj } from "./process";

/**
 * Before/after true-colour crops for an accuracy sample, without a database or the website, for a machine
 * with a fast connection:
 *
 *   npx tsx src/pipeline/s2/render-sample.ts --sample=sample.json --out=sample-out
 *
 * sample.json: [{ id, title, bbox: [w, s, e, n], ring: [[lon, lat], ...], before: cogUrl, after: cogUrl }].
 * Writes <out>/<id>-before.jpg and <id>-after.jpg (340 px, the outline drawn on the after image), the same
 * crop the website shows on a detection page.
 */
type Item = { id: string; bbox: [number, number, number, number]; ring: number[][]; before: string | null; after: string | null };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function crop(href: string, item: Item, outline: boolean): Promise<Buffer> {
  const epsg = epsgFromCogUrl(href);
  const [x0, y0] = toProj(epsg, item.bbox[0], item.bbox[1]);
  const [x1, y1] = toProj(epsg, item.bbox[2], item.bbox[3]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const half = Math.min(4000, Math.max(800, Math.max(x1 - x0, y1 - y0) * 0.9));
  const grid = makeGrid([cx - half, cy - half, cx + half, cy + half], 10);
  const rgb = await withRetry(() => readVisual(href, grid));
  const size = 340;
  const pts = item.ring
    .map(([lon, lat]) => {
      const [x, y] = toProj(epsg, lon, lat);
      return `${(((x - grid.bbox[0]) / grid.res) * size) / grid.width},${(((grid.bbox[3] - y) / grid.res) * size) / grid.height}`;
    })
    .join(" ");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><polygon points="${pts}" fill="none" stroke="#ffd400" stroke-width="2" stroke-dasharray="5 3"/></svg>`);
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(rgb), { raw: { width: grid.width, height: grid.height, channels: 3 } })
    .resize(size, size)
    .modulate({ brightness: 1.25 })
    .composite(outline && pts ? [{ input: svg }] : [])
    .jpeg({ quality: 78 })
    .toBuffer();
}

async function main() {
  const file = arg("sample");
  const out = arg("out") ?? "sample-out";
  if (!file) throw new Error("--sample=sample.json is required");
  mkdirSync(out, { recursive: true });
  const items = JSON.parse(readFileSync(file, "utf8")) as Item[];
  for (const it of items) {
    for (const [role, href] of [["before", it.before], ["after", it.after]] as const) {
      if (!href) continue;
      try {
        writeFileSync(join(out, `${it.id.slice(0, 8)}-${role}.jpg`), await crop(href, it, role === "after"));
      } catch (e) {
        console.log(it.id, role, e instanceof Error ? e.message : String(e));
      }
    }
    console.log("done", it.id.slice(0, 8));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
