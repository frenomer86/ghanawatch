import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { winAnsi } from "@/lib/server/land/pdf";
import type { ReleaseData } from "./data";

/**
 * The monthly report as an eight-page A4 PDF: headline, national trend, league table, river scorecard,
 * forest reserves, featured sites with before and after pictures, how the index is made, and where the
 * data is. Standard fonts only, so nothing has to be shipped with the server.
 */
const A4 = { w: 595.28, h: 841.89 };
const M = 44;
const INK = rgb(0.08, 0.13, 0.11);
const MUTED = rgb(0.36, 0.42, 0.39);
const FOREST = rgb(0.06, 0.24, 0.18);
const LATERITE = rgb(0.66, 0.32, 0.16);
const LINE = rgb(0.85, 0.88, 0.86);
const AMBER = rgb(0.94, 0.7, 0.42);

const ha = (v: number | null | undefined) => (v == null ? "–" : v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = winAnsi(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export interface FeaturedImage {
  siteId: string;
  before: Buffer | null;
  after: Buffer | null;
}

export async function releasePdf(d: ReleaseData, origin: string, images: FeaturedImage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Galamsey from Space, ${d.label}`);
  doc.setAuthor("GhanaWatch, KNUST");
  doc.setCreationDate(new Date());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const n = d.national;
  const start = d.series[0]?.month ?? d.month;

  let page!: PDFPage;
  let y = 0;
  const newPage = (title: string) => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M;
    page.drawText(winAnsi("GhanaWatch, KNUST"), { x: M, y, size: 9, font: bold, color: MUTED });
    const right = `Galamsey from Space · ${d.label} · index v${d.version}`;
    page.drawText(winAnsi(right), { x: A4.w - M - font.widthOfTextAtSize(right, 9), y, size: 9, font, color: MUTED });
    y -= 30;
    page.drawText(winAnsi(title), { x: M, y, size: 20, font: bold, color: FOREST });
    y -= 24;
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: A4.w - M, y: y + 6 }, thickness: 0.8, color: LINE });
    y -= 8;
  };
  const text = (t: string, size = 10, f = font, color = INK, width = A4.w - 2 * M, x = M) => {
    for (const line of wrap(t, f, size, width)) {
      if (y < M + 30) newPage("continued");
      page.drawText(line, { x, y, size, font: f, color });
      y -= size * 1.4;
    }
  };
  const gap = (v = 10) => (y -= v);
  const stat = (x: number, w: number, value: string, label: string, color = INK) => {
    page.drawRectangle({ x, y: y - 46, width: w, height: 54, color: rgb(0.95, 0.96, 0.95), borderColor: LINE, borderWidth: 0.5 });
    page.drawText(winAnsi(value), { x: x + 10, y: y - 20, size: 20, font: bold, color });
    page.drawText(winAnsi(label), { x: x + 10, y: y - 38, size: 8.5, font, color: MUTED });
  };
  const tableRow = (cols: Array<[string, number, boolean?]>, f = font, size = 9.5, color = INK) => {
    if (y < M + 30) newPage("continued");
    let x = M;
    for (const [t, w, right] of cols) {
      const s = winAnsi(t);
      const tw = f.widthOfTextAtSize(s, size);
      page.drawText(s, { x: right ? x + w - tw - 4 : x, y, size, font: f, color });
      x += w;
    }
    y -= size * 1.5;
  };
  const footer = (p: PDFPage, i: number) => {
    const t = `Page ${i} of 8 · ${origin}/monthly/${d.month} · CC BY 4.0 · Contains modified Copernicus Sentinel data · Changes seen from space, not legal findings`;
    p.drawText(winAnsi(t), { x: M, y: 24, size: 7.5, font, color: MUTED });
  };

  // 1 — Headline
  newPage("The headline");
  gap(12);
  page.drawText(winAnsi(`${ha(n.newHa)} ha`), { x: M, y: y - 36, size: 48, font: bold, color: LATERITE });
  y -= 50;
  text(`of land newly mined for gold was first seen from space in ${d.label}${n.ciLow != null ? `, likely between ${ha(n.ciLow)} and ${ha(n.ciHigh)} ha once false alarms and misses are allowed for` : ""}.`, 12, bold);
  gap(6);
  text(`Since ${d.series[0]?.label ?? d.label} the record stands at ${ha(n.cumHa)} ha across ${n.districtsAffected} districts this month${n.topDistrict ? `, led by ${n.topDistrict.name}` : ""}. ${ha(n.inReservesHa)} ha of this month's new mining lies inside forest reserves.`, 11);
  gap(14);
  const w3 = (A4.w - 2 * M - 20) / 3;
  stat(M, w3, `${n.newSites}`, "new sites this month");
  stat(M + w3 + 10, w3, `${n.districtsAffected}`, "districts with new mining");
  stat(M + 2 * (w3 + 10), w3, d.worstRiver ? `${d.worstRiver.kmDiscoloured} km` : "–", d.worstRiver ? `of the ${d.worstRiver.river} discoloured` : "no river discolouration seen");
  y -= 70;
  text("What the index is", 12, bold, FOREST);
  text(`The Galamsey Index is the hectares of land first seen as likely galamsey in a month, per 100 km² of each district, so that a small district and a large one can be compared. Districts rank by it; rank 1 is the worst month. Sites inside named large-scale mines are left out. The figures in this report are frozen: they will not change on the website, and any later correction is published on the methodology page.`, 10);
  gap(8);
  text(`Method: ${d.version}. Satellite: Copernicus Sentinel-2 (optical, 10 m) and Sentinel-1 (radar). Baseline: imagery one to two years before each month.`, 9, font, MUTED);
  footer(page, 1);

  // 2 — Trend
  newPage("The national trend");
  gap(6);
  text(`Hectares first seen as likely galamsey each month, ${d.series[0]?.label ?? ""} to ${d.label}. Bars are the mapped area, with the figure above each; the thin line is the likely range once false alarms and misses are allowed for, and an arrow means the top of the range is above the chart.`, 10, font, MUTED);
  gap(10);
  const chartH = 220;
  const chartW = A4.w - 2 * M;
  // The axis follows the mapped bars, so months stay readable; the range line is clipped and marked.
  const maxV = Math.max(1, ...d.series.map((s) => s.newHa)) * 1.25;
  const bw = chartW / Math.max(1, d.series.length);
  const base = y - chartH;
  page.drawLine({ start: { x: M, y: base }, end: { x: A4.w - M, y: base }, thickness: 0.8, color: LINE });
  const labelEvery = Math.ceil(d.series.length / 12);
  d.series.forEach((s, i) => {
    const h = Math.max(0, (s.newHa / maxV) * chartH);
    const cx = M + i * bw + bw * 0.5;
    page.drawRectangle({ x: M + i * bw + bw * 0.15, y: base, width: bw * 0.7, height: h, color: s.month === d.month ? FOREST : AMBER });
    if (s.ciLow != null && s.ciHigh != null) {
      const lo = Math.min(chartH, (s.ciLow / maxV) * chartH);
      const hi = Math.min(chartH, (s.ciHigh / maxV) * chartH);
      page.drawLine({ start: { x: cx, y: base + lo }, end: { x: cx, y: base + hi }, thickness: 0.8, color: MUTED });
      if ((s.ciHigh / maxV) * chartH > chartH) {
        // Arrowhead and the clipped value.
        page.drawLine({ start: { x: cx - 3, y: base + chartH - 4 }, end: { x: cx, y: base + chartH }, thickness: 0.8, color: MUTED });
        page.drawLine({ start: { x: cx + 3, y: base + chartH - 4 }, end: { x: cx, y: base + chartH }, thickness: 0.8, color: MUTED });
        if (d.series.length <= 18) page.drawText(winAnsi(`to ${ha(s.ciHigh)}`), { x: cx + 5, y: base + chartH - 6, size: 6.5, font, color: MUTED });
      }
    }
    if (d.series.length <= 24) {
      const v = winAnsi(ha(s.newHa));
      page.drawText(v, { x: cx - font.widthOfTextAtSize(v, 7) / 2, y: base + h + 3, size: 7, font: bold, color: INK });
    }
    if (i % labelEvery === 0 || i === d.series.length - 1) {
      page.drawText(s.month, { x: M + i * bw + 2, y: base - 12, size: 7, font, color: MUTED });
    }
  });
  y -= chartH + 30;
  tableRow([["Month", 110], ["New ha", 80, true], ["Low", 70, true], ["High", 70, true], ["Cumulative", 90, true], ["Districts", 70, true]], bold, 9, MUTED);
  for (const s of d.series.slice(-18)) tableRow([[s.label, 110], [ha(s.newHa), 80, true], [ha(s.ciLow), 70, true], [ha(s.ciHigh), 70, true], [ha(s.cumHa), 90, true], [String(s.districtsAffected), 70, true]]);
  footer(page, 2);

  // 3 — League table
  newPage(`The league table, ${d.label}`);
  gap(6);
  text("Every district with new mining this month, ranked by the index (new hectares per 100 km²).", 10, font, MUTED);
  gap(8);
  tableRow([["#", 26], ["District", 150], ["Region", 100], ["Index", 50, true], ["New ha", 60, true], ["Low–high", 80, true], [`Since ${start.slice(0, 4)}`, 70, true]], bold, 9, MUTED);
  for (const r of d.rankings.filter((r) => r.rank != null).slice(0, 40)) {
    tableRow([[String(r.rank), 26], [r.name, 150], [r.region?.replace(/ Region$/, "") ?? "", 100], [r.index.toFixed(1), 50, true], [ha(r.newHa), 60, true], [`${ha(r.ciLow)}–${ha(r.ciHigh)}`, 80, true], [ha(r.cumHa), 70, true]]);
  }
  footer(page, 3);

  // 4 — Rivers
  newPage("The rivers");
  gap(6);
  text("Kilometres of each watched river where Sentinel-2 saw the water turn brown this month, with the reaches that hold drinking-water intakes.", 10, font, MUTED);
  gap(8);
  tableRow([["River", 90], ["Mapped length", 90, true], ["Discoloured", 80, true], ["Heavily", 70, true], ["Muddy sites", 70, true], ["Dredger targets", 90, true]], bold, 9, MUTED);
  for (const r of d.rivers) tableRow([[r.river, 90], [r.mapped ? `${r.lengthKm} km` : "not mapped", 90, true], [`${r.kmDiscoloured} km`, 80, true], [`${r.kmHeavy} km`, 70, true], [String(r.muddySites), 70, true], [String(r.dredgerTargets), 90, true]]);
  gap(10);
  text("Drinking-water intakes", 12, bold, FOREST);
  for (const r of d.rivers) {
    for (const i of r.intakes) {
      const reach = r.reaches.find((x) => x.intakes.some((y) => y.id === i.id));
      text(`${i.name} (${r.river}): reach ${reach ? `${reach.startKm}–${reach.endKm} km is ${reach.class === "clear" ? "clear" : reach.class === "heavy" ? "heavily discoloured" : "discoloured"}` : "not on a mapped reach"}.`, 10);
    }
  }
  if (!d.rivers.some((r) => r.intakes.length)) text("No intakes on record yet.", 10, font, MUTED);
  footer(page, 4);

  // 5 — Reserves
  newPage("Forest reserves");
  gap(6);
  text(`${ha(n.inReservesHa)} ha of this month's new mining lies inside forest reserves and other protected areas.`, 10, font, MUTED);
  gap(8);
  tableRow([["Reserve", 220], ["New ha", 70, true], ["Sites", 50, true], ["Districts", 160]], bold, 9, MUTED);
  for (const r of d.reserves.slice(0, 35)) tableRow([[r.name, 220], [ha(r.newHa), 70, true], [String(r.sites), 50, true], [r.districts.join(", "), 160]]);
  if (!d.reserves.length) text("No new mining inside a reserve was first seen this month.", 10, font, MUTED);
  footer(page, 5);

  // 6 — Featured sites
  newPage("Six sites, before and after");
  gap(4);
  text("The largest sites first seen this month that have clear pictures. Left: a year or more earlier. Right: this month, outlined. Sentinel-2 true colour, 10 m.", 9.5, font, MUTED);
  gap(6);
  const cellW = (A4.w - 2 * M - 10) / 2;
  const imgW = (cellW - 30) / 2;
  let col = 0;
  for (const s of d.featured) {
    const img = images.find((i) => i.siteId === s.id);
    const x0 = M + col * (cellW + 10);
    if (col === 0 && y - imgW - 40 < M + 20) newPage("Six sites, before and after (continued)");
    const top = y;
    page.drawText(winAnsi(`${s.districtName ?? ""} · ${ha(s.areaHa)} ha${s.reserve ? ` · inside ${s.reserve}` : ""}`), { x: x0, y: top - 10, size: 8.5, font: bold, color: INK });
    for (const [k, buf] of [
      [0, img?.before],
      [1, img?.after],
    ] as const) {
      const bx = x0 + k * (imgW + 10);
      const by = top - 16 - imgW;
      if (buf) {
        const jpg = await doc.embedJpg(buf);
        page.drawImage(jpg, { x: bx, y: by, width: imgW, height: imgW });
      } else page.drawRectangle({ x: bx, y: by, width: imgW, height: imgW, color: rgb(0.93, 0.94, 0.93) });
      page.drawText(k === 0 ? "Before" : `After · ${s.imageDate ?? ""}`, { x: bx, y: by - 10, size: 7.5, font, color: MUTED });
    }
    page.drawText(winAnsi(`${origin}/event/${s.eventId}`), { x: x0, y: top - 16 - imgW - 20, size: 6.5, font, color: MUTED });
    if (col === 1) y -= imgW + 46;
    col = 1 - col;
  }
  if (!d.featured.length) text("No site this month has a clear before and after picture yet; the evidence pages carry each site's imagery as it arrives.", 10, font, MUTED);
  footer(page, 6);

  // 7 — Method
  newPage("How the index is made");
  gap(6);
  for (const p of [
    ...(d.multisensor
      ? [
          "Detection. Every 0.2° cell of Ghana has a monthly record since 2017. Each month, every Sentinel-2 image is composited in all ten bands with per-pixel cloud, haze and shadow screening; Landsat 8 and 9 fill what cloud hid, cross-calibrated to Sentinel-2; Sentinel-1 radar (VV and VH) sees through cloud; the Copernicus DEM gives slope and relative height. A U-Net trained on hand-mapped Ghanaian mines (SmallMinesDS) scores the 24 inputs, and a per-pixel hidden Markov tracker accumulates the months: a square is mined only once the evidence holds, and its onset month never moves. Sites are placed against OpenStreetMap: reserves, towns, schools, clinics, named mines.",
          "Checks. The savannah north, the lake shores and the coastal plains move to low confidence unless the signal is very strong; a site a moderator or the monthly confirmation sample rejects leaves the index; named large-scale mines are labelled and never counted.",
          "Sites. Connected mined squares of at least 0.3 ha form a site, named by its earliest ground so it keeps its name as it grows. A month counts the ground confirmed in that month only, so neither a site nor its spread is counted twice.",
        ]
      : [
          "Detection. Every 0.2° cell of Ghana is scanned in rotation. A cloud-masked median of the clearest Sentinel-2 scenes of the last 120 days is compared with one from one to two years earlier; cleared ground with new water-filled pits, and clusters of new pits, are the galamsey signature. Radar (Sentinel-1) adds new ponds under cloud. Detections are placed against OpenStreetMap: reserves, towns, schools, clinics, named mines.",
          "Checks. Lone clearings, lone ponds, building in towns, the lake shores and the coastal plains move to low confidence; a second source (Global Forest Watch alerts) raises confidence; named large-scale mines are labelled and never counted.",
          "Sites. A detection within about 200 m of an earlier one is the same site. A site counts in the month it was first seen; a rescan that confirms it does not make it new again.",
        ]),
    d.multisensor
      ? "Index. new_ha is the ground newly confirmed as mined in the month (new sites and the spread of existing ones), outside named mines; the index is new_ha per 100 km² of the district; cumulative is the running sum. Rank 1 is the highest index."
      : "Index. new_ha is the area of sites first seen in the month, outside named mines; the index is new_ha per 100 km² of the district; cumulative is the running sum. Rank 1 is the highest index.",
    `Uncertainty. The interval corrects mapped area for the latest measured precision (random detections checked by eye) and detection rate (blind squares), with Wilson 95% intervals on both.`,
    "Frozen numbers. A closed month never changes under the same index version. A method change creates a new version, reprocesses the whole series and is recorded on the corrections log at /data/methods.",
    "Limits. Cloud hides the ground for weeks in the rainy season; sites under 0.5 ha are below what the scan confirms; the savannah north is shown at low confidence; legality is unknown wherever the mining cadastre is not loaded. None of this is a legal finding.",
  ])
    text(p, 10);
  footer(page, 7);

  // 8 — Data
  newPage("Where the data is");
  gap(6);
  for (const line of [
    `Report page: ${origin}/monthly/${d.month}`,
    `Files (CC BY 4.0): ${origin}/releases/${d.month}/`,
    `  ghanawatch_index_${d.month}.csv — the index per district`,
    `  ghanawatch_national_${d.month}.csv — the national series`,
    `  ghanawatch_districts_${d.month}.geojson — district outlines with their figures`,
    `  ghanawatch_sites_${d.month}.geojson — every site first seen this month, with its evidence page`,
    `  ghanawatch_rivers_${d.month}.csv, ghanawatch_reserves_${d.month}.csv`,
    `  manifest.json — file hashes, method and index versions`,
    `API: ${origin}/api/v1/national?month=${d.month} · ${origin}/api/v1/index?month=${d.month} · ${origin}/api/v1/scorecards/{district}`,
    `Rankings: ${origin}/districts · Rivers: ${origin}/rivers · Accuracy: ${origin}/data/accuracy`,
    "Cite as: GhanaWatch (KNUST). Galamsey from Space, monthly release, " + d.label + ". Index version " + d.version + ".",
    "Contact: the GhanaWatch team at KNUST. Corrections are welcome and are published.",
  ])
    text(line, 10);
  footer(page, 8);

  return doc.save();
}
