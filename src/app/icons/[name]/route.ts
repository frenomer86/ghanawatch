import { HttpError, handle } from "@/lib/server/http";

/**
 * GET /icons/icon-192.png, /icons/icon-512.png, /icons/icon-maskable-512.png — the app icons the web
 * manifest names (they were missing, so every page logged a 404 for them). Drawn from the GhanaWatch mark
 * (src/components/layout/wordmark.tsx) with sharp, once per process; the maskable icon keeps the mark
 * inside the central safe zone on a full-bleed background.
 */
const ICONS: Record<string, { size: number; maskable: boolean }> = {
  "icon-192.png": { size: 192, maskable: false },
  "icon-512.png": { size: 512, maskable: false },
  "icon-maskable-512.png": { size: 512, maskable: true },
};

const FOREST = "#0f3d2e";
const PAPER = "#f5f7f4";
const AMBER = "#e2a92b";

function svg(size: number, maskable: boolean): string {
  // The mark is drawn on a 32-unit grid; the maskable icon scales it into the inner 60 %.
  const scale = (maskable ? 0.6 : 0.86) * (size / 32);
  const offset = (size - 32 * scale) / 2;
  const bg = maskable ? FOREST : PAPER;
  const ink = maskable ? PAPER : FOREST;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${maskable ? 0 : size * 0.22}" fill="${bg}"/>
<g transform="translate(${offset} ${offset}) scale(${scale})">
<circle cx="16" cy="16" r="14.5" fill="none" stroke="${ink}" stroke-width="1.5" opacity="0.55"/>
<circle cx="16" cy="16" r="9.5" fill="${ink}"/>
<circle cx="21" cy="11.5" r="2.6" fill="${AMBER}" stroke="${bg}" stroke-width="1.2"/>
</g></svg>`;
}

const rendered = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

export const GET = handle(async (_req, ctx) => {
  const { name } = await ctx.params;
  const icon = Object.hasOwn(ICONS, name) ? ICONS[name] : null;
  if (!icon) throw new HttpError(404, "No such icon");
  let png = rendered.get(name);
  if (!png) {
    png = import("sharp").then(async ({ default: sharp }) => new Uint8Array(await sharp(Buffer.from(svg(icon.size, icon.maskable))).png().toBuffer()) as Uint8Array<ArrayBuffer>);
    rendered.set(name, png);
    png.catch(() => rendered.delete(name));
  }
  return new Response(await png, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=604800, stale-while-revalidate=2592000", "x-content-type-options": "nosniff" },
  });
});
