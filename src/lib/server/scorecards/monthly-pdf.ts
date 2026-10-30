import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { winAnsi } from "@/lib/server/land/pdf";
import type { MonthlyReport } from "./monthly";

/**
 * The monthly "State of Ghana's Environment" report as a two-page A4 PDF with
 * standard fonts: national figures, the ten districts with the most likely
 * mining first seen in the month, the reserves affected, and the limits.
 */
const A4 = { w: 595.28, h: 841.89 };
const M = 44;
const INK = rgb(0.08, 0.13, 0.11);
const MUTED = rgb(0.36, 0.42, 0.39);
const FOREST = rgb(0.06, 0.24, 0.18);
const LATERITE = rgb(0.66, 0.32, 0.16);
const LINE = rgb(0.85, 0.88, 0.86);

const ha = (v: number) => (v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));

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

export async function monthlyPdf(r: MonthlyReport, onlineUrl: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`State of Ghana's Environment, ${r.label}`);
  doc.setAuthor("GhanaWatch");
  doc.setCreationDate(new Date(r.generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const write = (t: string, x: number, size: number, f = font, color = INK) => page.drawText(winAnsi(t), { x, y, size, font: f, color });
  const para = (t: string, size = 10, f = font, color = INK, width = A4.w - 2 * M) => {
    for (const line of wrap(t, f, size, width)) {
      if (y < M + 40) {
        page = doc.addPage([A4.w, A4.h]);
        y = A4.h - M;
      }
      write(line, M, size, f, color);
      y -= size * 1.35;
    }
  };

  write("State of Ghana's Environment", M, 22, bold, FOREST);
  y -= 24;
  write(`${r.label}${r.partial ? " (month in progress)" : ""}`, M, 14, bold, LATERITE);
  const gen = `Generated ${new Date(r.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
  write(gen, A4.w - M - font.widthOfTextAtSize(gen, 9), 9, font, MUTED);
  y -= 16;
  write("GhanaWatch, Ghana Environmental Monitoring and Early-Warning Platform", M, 9, font, MUTED);
  y -= 22;
  if (r.firstMonth) {
    para(
      `This is GhanaWatch's first month of national scanning, so it includes every change found by comparing the last 120 days with imagery from one to two years earlier, not only changes that began in ${r.label}.`,
      9.5,
      font,
      MUTED,
    );
    y -= 6;
  }

  const n = r.national;
  const tiles: Array<[string, string]> = [
    [`${ha(n.miningHa)} ha`, `likely galamsey first seen (${n.miningSites.toLocaleString("en-GB")} sites, ${n.districtsWithMining} districts)`],
    [`${ha(n.inReservesHa)} ha`, `inside forest reserves (${n.reservesAffected} reserves)`],
    [n.nearPeople.toLocaleString("en-GB"), "sites within 300 m of homes, schools or clinics"],
    [n.muddyRivers.toLocaleString("en-GB"), "river stretches turned muddy"],
    [n.fires.toLocaleString("en-GB"), `vegetation fires${n.firesSince ? ` since ${n.firesSince}` : ""}${n.firesUsual !== null ? ` (usual for the month: ${n.firesUsual.toLocaleString("en-GB")})` : ""}`],
    [`${ha(n.radarHa)} ha`, "new ponds seen by radar through cloud"],
  ];
  const colW = (A4.w - 2 * M - 16) / 2;
  for (let i = 0; i < tiles.length; i += 2) {
    for (let k = 0; k < 2 && i + k < tiles.length; k++) {
      const x = M + k * (colW + 16);
      page.drawRectangle({ x, y: y - 40, width: colW, height: 50, color: rgb(0.96, 0.95, 0.92) });
      page.drawText(winAnsi(tiles[i + k][0]), { x: x + 10, y: y - 10, size: 17, font: bold, color: k === 0 && i === 0 ? LATERITE : INK });
      const lines = wrap(tiles[i + k][1], font, 8.5, colW - 20);
      lines.slice(0, 2).forEach((l, j) => page.drawText(l, { x: x + 10, y: y - 24 - j * 10, size: 8.5, font, color: MUTED }));
    }
    y -= 60;
  }
  y -= 6;

  write("Districts with the most likely galamsey first seen this month", M, 12, bold, FOREST);
  y -= 16;
  const cols = [M, M + 24, M + 250, M + 330, M + 400, M + 460];
  const head = ["#", "District", "Likely mining", "Sites", "In reserves", "Near people"];
  head.forEach((h, i) => page.drawText(h, { x: cols[i], y, size: 8.5, font: bold, color: MUTED }));
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.6, color: LINE });
  y -= 12;
  r.topDistricts.forEach((d, i) => {
    const cells = [String(i + 1), `${d.name} (${(d.region ?? "").replace(/ Region$/, "")})`, `${ha(d.miningHa)} ha`, String(d.miningSites), `${ha(d.inReservesHa)} ha`, String(d.nearPeople)];
    cells.forEach((c, k) => page.drawText(winAnsi(c).slice(0, k === 1 ? 46 : 20), { x: cols[k], y, size: 9, font: k === 1 ? bold : font, color: INK }));
    y -= 14;
  });
  if (!r.topDistricts.length) {
    para("No likely mining was first seen this month.", 9.5, font, MUTED);
  }
  y -= 8;

  if (r.topReserves.length) {
    write("Forest reserves most affected", M, 12, bold, FOREST);
    y -= 15;
    for (const res of r.topReserves) para(`${res.name}: ${ha(res.miningHa)} ha likely mining, ${ha(res.clearedHa)} ha cleared (${res.districts.join(", ")})`, 9.5);
    y -= 6;
  }
  if (r.regions.length) {
    write("By region", M, 12, bold, FOREST);
    y -= 15;
    para(r.regions.map((g) => `${g.region.replace(/ Region$/, "")} ${ha(g.miningHa)} ha`).join(" · "), 9.5);
    y -= 6;
  }

  write("How to read this", M, 12, bold, FOREST);
  y -= 15;
  para(
    "Likely galamsey is new mining pits and ponds seen from space that passed GhanaWatch's checks. Work inside named large-scale mines is left out, and the savannah north is under-counted. Fires are satellite fire detections. These are changes seen from space, not legal findings; ground verification is encouraged.",
    9,
    font,
    MUTED,
  );
  y -= 6;
  para(`Live figures and every detection with its satellite images: ${onlineUrl}`, 9, bold, INK);
  para(
    "Contains modified Copernicus Sentinel data. Fire data: NASA FIRMS. Map data: OpenStreetMap contributors.",
    8,
    font,
    MUTED,
  );
  return doc.save();
}
