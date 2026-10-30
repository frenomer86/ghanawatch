import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { DistrictMonth } from "@/lib/server/index/read";

/**
 * The frozen share cards of a release, drawn as SVG and rasterised with sharp: a WhatsApp-sized square
 * (1080×1080) and a link-preview rectangle (1200×630) per district, with the index, the rank and its
 * movement, the cumulative hectares, a small district outline, the GhanaWatch mark and the release date.
 * The live card route keeps changing with every scan; these never change once published.
 */
const INK = "#f4efe6";
const SOFT = "#c9d8cf";
const AMBER = "#f0b46a";
const BG = "#0f2e22";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The rank tile is narrow: "up 3" / "down 2" / "new" fit beside the district count, "unchanged" is said by the arrow alone. */
const shortMove = (t: string) => {
  const m = t.match(/(up|down) from (\d+)/i);
  if (m) return ` · was #${m[2]}`;
  return /newly/i.test(t) ? " · new" : "";
};
const ha = (v: number) => (v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));

function outlinePath(geom: Geometry | null, box: { x: number; y: number; w: number; h: number }): string {
  if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) return "";
  const polys = geom.type === "Polygon" ? [(geom as Polygon).coordinates] : (geom as MultiPolygon).coordinates;
  const pts = polys.flatMap((p) => p[0]);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const sx = box.w / Math.max(1e-6, maxLon - minLon);
  const sy = box.h / Math.max(1e-6, maxLat - minLat);
  const s = Math.min(sx, sy);
  const ox = box.x + (box.w - (maxLon - minLon) * s) / 2;
  const oy = box.y + (box.h - (maxLat - minLat) * s) / 2;
  return polys
    .map((p) => {
      const ring = p[0];
      const step = Math.max(1, Math.floor(ring.length / 400));
      const d = ring
        .filter((_, i) => i % step === 0)
        .map(([lon, lat], i) => `${i ? "L" : "M"}${(ox + (lon - minLon) * s).toFixed(1)} ${(oy + (maxLat - lat) * s).toFixed(1)}`)
        .join(" ");
      return `${d} Z`;
    })
    .join(" ");
}

export interface CardInput {
  d: DistrictMonth;
  total: number;
  label: string;
  releaseDate: string;
  outline: Geometry | null;
}

export function squareCardSvg({ d, total, label, releaseDate, outline }: CardInput): string {
  const arrow = d.movement.arrow === "up" ? "▲" : d.movement.arrow === "down" ? "▼" : d.movement.arrow === "new" ? "●" : "";
  const path = outlinePath(outline, { x: 720, y: 560, w: 300, h: 300 });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
<rect width="1080" height="1080" fill="${BG}"/>
<circle cx="80" cy="78" r="22" fill="none" stroke="${AMBER}" stroke-width="6"/>
<text x="118" y="90" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="${INK}">GhanaWatch</text>
<text x="1020" y="90" text-anchor="end" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="26" fill="${SOFT}">Galamsey Index · ${esc(label)}</text>
<text x="60" y="230" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="${INK}">${esc(d.name)}</text>
<text x="60" y="282" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="32" fill="${SOFT}">${esc(d.region?.replace(/ Region$/, "") ?? "")}</text>
<text x="60" y="470" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="150" font-weight="800" fill="${AMBER}">${ha(d.newHa)} ha</text>
<text x="60" y="530" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="34" fill="${INK}">newly mined in ${esc(label)}</text>
<text x="60" y="580" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="30" fill="${SOFT}">${d.ciLow != null && d.ciHigh != null ? `likely between ${ha(d.ciLow)} and ${ha(d.ciHigh)} ha` : "mapped area"}</text>
<path d="${path}" fill="none" stroke="${SOFT}" stroke-width="3"/>
<rect x="60" y="660" width="300" height="150" rx="18" fill="rgba(255,255,255,0.07)"/>
<text x="80" y="720" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="54" font-weight="700" fill="${INK}">${d.rank ? `#${d.rank}` : "–"} <tspan font-size="30" fill="${AMBER}">${arrow}</tspan></text>
<text x="80" y="770" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="24" fill="${SOFT}">of ${total} districts${shortMove(d.movement.text)}</text>
<rect x="380" y="660" width="300" height="150" rx="18" fill="rgba(255,255,255,0.07)"/>
<text x="400" y="720" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="54" font-weight="700" fill="${INK}">${d.index.toFixed(1)}</text>
<text x="400" y="770" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="24" fill="${SOFT}">ha per 100 km² (the index)</text>
<rect x="60" y="840" width="620" height="150" rx="18" fill="rgba(255,255,255,0.07)"/>
<text x="80" y="900" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="54" font-weight="700" fill="${INK}">${ha(d.cumHa)} ha</text>
<text x="80" y="950" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="24" fill="${SOFT}">since the start of the record${d.pctForest ? ` · ${d.pctForest}% of this month inside forest reserves` : ""}</text>
<text x="60" y="1030" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="20" fill="#9fb5a8">GhanaWatch, KNUST · released ${esc(releaseDate)} · not a legal finding</text>
<text x="60" y="1058" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="20" fill="#9fb5a8">Contains modified Copernicus Sentinel data</text>
</svg>`;
}

export function wideCardSvg({ d, total, label, releaseDate, outline }: CardInput): string {
  const arrow = d.movement.arrow === "up" ? "▲" : d.movement.arrow === "down" ? "▼" : d.movement.arrow === "new" ? "●" : "";
  const path = outlinePath(outline, { x: 920, y: 150, w: 230, h: 230 });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${BG}"/>
<circle cx="76" cy="66" r="18" fill="none" stroke="${AMBER}" stroke-width="5"/>
<text x="108" y="76" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="${INK}">GhanaWatch</text>
<text x="1140" y="76" text-anchor="end" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="24" fill="${SOFT}">Galamsey Index · ${esc(label)}</text>
<text x="60" y="180" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="62" font-weight="700" fill="${INK}">${esc(d.name)}</text>
<text x="60" y="222" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="28" fill="${SOFT}">${esc(d.region?.replace(/ Region$/, "") ?? "")}</text>
<text x="60" y="360" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="110" font-weight="800" fill="${AMBER}">${ha(d.newHa)} ha</text>
<text x="60" y="408" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="28" fill="${INK}">newly mined in ${esc(label)}${d.ciLow != null && d.ciHigh != null ? ` (likely ${ha(d.ciLow)} to ${ha(d.ciHigh)} ha)` : ""}</text>
<path d="${path}" fill="none" stroke="${SOFT}" stroke-width="2.5"/>
<rect x="60" y="450" width="260" height="110" rx="14" fill="rgba(255,255,255,0.07)"/>
<text x="80" y="498" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="${INK}">${d.rank ? `#${d.rank}` : "–"} <tspan font-size="24" fill="${AMBER}">${arrow}</tspan></text>
<text x="80" y="536" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="20" fill="${SOFT}">of ${total} districts${shortMove(d.movement.text)}</text>
<rect x="340" y="450" width="260" height="110" rx="14" fill="rgba(255,255,255,0.07)"/>
<text x="360" y="498" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="${INK}">${d.index.toFixed(1)}</text>
<text x="360" y="536" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="20" fill="${SOFT}">ha per 100 km²</text>
<rect x="620" y="450" width="260" height="110" rx="14" fill="rgba(255,255,255,0.07)"/>
<text x="640" y="498" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="${INK}">${ha(d.cumHa)} ha</text>
<text x="640" y="536" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="20" fill="${SOFT}">since the record began</text>
<text x="60" y="604" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="18" fill="#9fb5a8">GhanaWatch, KNUST · released ${esc(releaseDate)} · contains modified Copernicus Sentinel data · not a legal finding</text>
</svg>`;
}

export async function svgToPng(svg: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
