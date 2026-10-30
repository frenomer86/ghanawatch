import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { LandChange, LandSummary } from "@/lib/domain/land";
import { dmy, findings, ha } from "@/lib/domain/land-findings";

/**
 * One-page "Check this land" report as a PDF, built with pdf-lib and the
 * standard Helvetica fonts (no font files to ship). Every finding names its
 * source and period; the limits and a plain disclaimer are always printed.
 */
const A4 = { w: 595.28, h: 841.89 };
const M = 40;
const INK = rgb(0.08, 0.13, 0.11);
const MUTED = rgb(0.36, 0.42, 0.39);
const FOREST = rgb(0.06, 0.24, 0.18);
const LINE = rgb(0.85, 0.88, 0.86);

export interface PdfImages {
  before: { jpeg: Buffer; caption: string } | null;
  after: { jpeg: Buffer; caption: string } | null;
  closeUp: { jpeg: Buffer; caption: string } | null;
}

/** Helvetica only covers WinAnsi; replace anything else rather than fail. */
export function winAnsi(s: string): string {
  return s
    .replace(/[ɛƐ]/g, "e")
    .replace(/[ɔƆ]/g, "o")
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[→]/g, "->")
    .replace(/[^\x20-\x7e\xa0-\xff–—‘’“”•…·]/g, "?");
}

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

export async function landPdf(s: LandSummary, c: LandChange | null, images: PdfImages, onlineUrl: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("GhanaWatch: Check this land");
  doc.setAuthor("GhanaWatch");
  doc.setSubject(`Land check around ${s.plot.lat.toFixed(5)}, ${s.plot.lon.toFixed(5)}`);
  doc.setCreationDate(new Date(s.generatedAt));
  const page = doc.addPage([A4.w, A4.h]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = A4.h - M;

  const text = (p: PDFPage, t: string, x: number, size: number, f = font, color = INK) => p.drawText(winAnsi(t), { x, y, size, font: f, color });

  text(page, "Check this land", M, 20, bold, FOREST);
  text(page, `Generated ${dmy(s.generatedAt)}`, A4.w - M - font.widthOfTextAtSize(`Generated ${dmy(s.generatedAt)}`, 9), 9, font, MUTED);
  y -= 15;
  text(page, "GhanaWatch, Ghana Environmental Monitoring and Early-Warning Platform", M, 9, font, MUTED);
  y -= 20;
  const place = [s.place.district, s.place.region].filter(Boolean).join(", ");
  for (const line of wrap(
    `Plot: circle of ${s.plot.radiusM} m radius (${ha(s.plot.areaHa)}) around ${s.plot.lat.toFixed(5)}, ${s.plot.lon.toFixed(5)}${place ? `, ${place}` : ""}.`,
    bold,
    10.5,
    A4.w - 2 * M,
  )) {
    text(page, line, M, 10.5, bold);
    y -= 14;
  }
  y -= 6;

  // Pictures: early 2020, the latest yearly view, and the newest close-up.
  const pics = [images.before, images.after, images.closeUp].filter((p): p is NonNullable<typeof p> => p !== null);
  if (pics.length) {
    const gap = 10;
    const w = (A4.w - 2 * M - gap * (pics.length - 1)) / pics.length;
    const top = y;
    for (let i = 0; i < pics.length; i++) {
      const img = await doc.embedJpg(pics[i].jpeg);
      const x = M + i * (w + gap);
      page.drawImage(img, { x, y: top - w, width: w, height: w });
      let cy = top - w - 11;
      for (const line of wrap(pics[i].caption, font, 7.5, w)) {
        page.drawText(line, { x, y: cy, size: 7.5, font, color: MUTED });
        cy -= 9;
      }
    }
    y = top - w - 38;
  }

  // Findings.
  const labelW = 150;
  for (const f of findings(s, c)) {
    if (y < 150) break;
    page.drawLine({ start: { x: M, y: y + 9 }, end: { x: A4.w - M, y: y + 9 }, thickness: 0.5, color: LINE });
    const startY = y;
    for (const line of wrap(f.label, bold, 9.5, labelW - 8)) {
      text(page, line, M, 9.5, bold);
      y -= 12;
    }
    let vy = startY;
    for (const line of wrap(f.value, font, 9.5, A4.w - 2 * M - labelW)) {
      page.drawText(line, { x: M + labelW, y: vy, size: 9.5, font, color: INK });
      vy -= 12;
    }
    if (f.source) {
      for (const line of wrap(f.source, font, 7.5, A4.w - 2 * M - labelW)) {
        page.drawText(line, { x: M + labelW, y: vy, size: 7.5, font, color: MUTED });
        vy -= 9.5;
      }
    }
    y = Math.min(y, vy) - 8;
  }

  // Limits and disclaimer, always printed, straight after the findings.
  y -= 4;
  page.drawLine({ start: { x: M, y: y + 9 }, end: { x: A4.w - M, y: y + 9 }, thickness: 0.5, color: LINE });
  text(page, "Read this before relying on it", M, 9.5, bold);
  y -= 13;
  const limits =
    "This report summarises public satellite data. It is not a land title search, a survey or a legal finding. Changes smaller than a few pixels, very recent changes and changes hidden by cloud can be missed; cleared land can be farming as well as mining. Close-up pictures can be months or years old. Check on the ground and with the Lands Commission before any decision.";
  for (const line of wrap(limits, font, 8.5, A4.w - 2 * M)) {
    text(page, line, M, 8.5, font, INK);
    y -= 11;
  }
  y -= 4;
  const credits =
    "Sources: Copernicus Sentinel-2 (ESA/EU) via Earth Search on AWS; Sentinel-2 cloudless by EOX IT Services GmbH (CC BY-NC-SA 4.0); Esri World Imagery (Vantor, Maxar, Earthstar Geographics); Global Forest Watch (Hansen et al. 2013, GLAD and RADD alerts); NASA FIRMS; OpenStreetMap contributors.";
  for (const line of wrap(credits, font, 7, A4.w - 2 * M)) {
    text(page, line, M, 7, font, MUTED);
    y -= 9;
  }
  y -= 2;
  for (const line of wrap(`Online version: ${onlineUrl}`, font, 7, A4.w - 2 * M)) {
    text(page, line, M, 7, font, MUTED);
    y -= 9;
  }
  return doc.save();
}
