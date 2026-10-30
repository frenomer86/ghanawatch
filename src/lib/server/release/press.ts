import { docx, type DocxParagraph } from "@/lib/server/docx";
import type { ReleaseData } from "./data";

/**
 * The press release of a monthly release, from a template filled with the month's numbers. The lead
 * paragraph names the national figure, the rank-1 district and the worst river. Written as Markdown and
 * as a Word document, both from the same paragraphs.
 */
const ha = (v: number | null | undefined) => (v == null ? "–" : v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));

export interface PressRelease {
  headline: string;
  paragraphs: DocxParagraph[];
  markdown: string;
  docx: Buffer;
  /** Under 1,000 characters, for the WhatsApp channel. */
  whatsapp: string;
  /** Up to eight tweets. */
  thread: string[];
}

export function pressRelease(d: ReleaseData, origin: string, releaseDate: string): PressRelease {
  const n = d.national;
  const top = d.top[0] ?? null;
  const river = d.worstRiver;
  const first = d.series[0];
  const headline =
    n.newHa > 0
      ? `${ha(n.newHa)} hectares newly mined for gold in ${d.label}, satellite record shows`
      : `No new galamsey passed the checks in ${d.label}; cloud may have hidden the ground`;
  const lead = `${ha(n.newHa)} hectares of land across ${n.districtsAffected} districts of Ghana were first seen as likely galamsey from space in ${d.label}${n.ciLow != null ? `, between ${ha(n.ciLow)} and ${ha(n.ciHigh)} hectares once false alarms and missed sites are allowed for` : ""}, according to the GhanaWatch Galamsey Index published today by researchers at KNUST.${top ? ` ${top.name} (${top.region?.replace(/ Region$/, "") ?? ""}) ranks first, with ${ha(top.newHa)} hectares newly mined, ${top.index.toFixed(1)} hectares for every 100 km² of the district.` : ""}${river ? ` On the ${river.river}, ${river.kmDiscoloured} km of river water turned brown in the same images.` : ""}`;
  const since = first ? `Since ${first.label} the record stands at ${ha(n.cumHa)} hectares.` : "";
  const reserves = n.inReservesHa > 0 ? `${ha(n.inReservesHa)} hectares of this month's new mining lies inside forest reserves${d.reserves[0] ? `, the largest share in ${d.reserves[0].name}` : ""}.` : "No new mining was first seen inside a forest reserve this month.";
  const movers = d.top.slice(0, 5).map((t) => `${t.rank}. ${t.name} (${ha(t.newHa)} ha, index ${t.index.toFixed(1)})`).join("; ");
  const paragraphs: DocxParagraph[] = [
    { text: "GhanaWatch, KNUST · Press release", style: "Heading2" },
    { text: headline, style: "Title" },
    { text: `Kumasi, ${releaseDate}. For immediate release.`, bold: true },
    { text: lead },
    { text: `${since} ${reserves}` },
    { text: `The ten districts ranked highest this month: ${movers}${d.top.length > 5 ? "; and " + d.top.slice(5).map((t) => `${t.rank}. ${t.name}`).join("; ") : ""}.` },
    { text: "How it is measured", style: "Heading1" },
    {
      text: "GhanaWatch scans the whole of Ghana with free Copernicus Sentinel-2 and Sentinel-1 satellite data and compares each month with imagery from one to two years earlier. Cleared ground with new water-filled pits is the signature of small-scale mining. A detection within 200 m of an earlier one is the same site, and a site counts only in the month it was first seen, so the index never counts the same ground twice. Work inside named large-scale mines is excluded. Every figure is frozen when the month closes; corrections, if any, are published.",
    },
    {
      text: `Accuracy is measured, not assumed: random detections are checked against before and after pictures, and blind squares measure what the scan misses. The interval quoted above comes from those checks. Full method: ${origin}/data/methods. Accuracy: ${origin}/data/accuracy.`,
    },
    { text: "Evidence", style: "Heading1" },
    {
      text: d.featured.length ? `Before and after pictures of the largest new sites are at ${d.featured.map((s) => `${origin}/event/${s.eventId}`).join(", ")}. Every site in the index has a page of its own with the satellite dates, coordinates and a download.` : `Every site in the index has a page of its own with the satellite dates, coordinates and a download: ${origin}/districts.`,
    },
    { text: "Data", style: "Heading1" },
    { text: `The full index, district outlines and sites are published under CC BY 4.0 at ${origin}/releases/${d.month}/ and through the API at ${origin}/api/v1/index?month=${d.month}. District scorecards: ${origin}/districts. Rivers: ${origin}/rivers.` },
    { text: "About GhanaWatch", style: "Heading1" },
    { text: "GhanaWatch is an independent satellite monitor of Ghana's land and rivers built at Kwame Nkrumah University of Science and Technology. It publishes the Galamsey Index on a fixed day every month, with the evidence behind every number. It is not a legal finding: it shows what changed on the ground as seen from space." },
    { text: "Contact", style: "Heading1" },
    { text: `GhanaWatch team, KNUST · ${origin}` },
  ];
  const markdown = paragraphs
    .map((p) => (p.style === "Title" ? `# ${p.text}` : p.style === "Heading1" ? `## ${p.text}` : p.style === "Heading2" ? `*${p.text}*` : p.bold ? `**${p.text}**` : p.text))
    .join("\n\n");
  const whatsapp = clip(
    `*Galamsey Index, ${d.label}*\n${ha(n.newHa)} ha newly mined for gold, first seen from space${n.ciLow != null ? ` (likely ${ha(n.ciLow)}–${ha(n.ciHigh)} ha)` : ""}.${top ? `\nWorst district: ${top.name}, ${ha(top.newHa)} ha.` : ""}${river ? `\n${river.river}: ${river.kmDiscoloured} km of water turned brown.` : ""}\n${since}\nFull report and every site: ${origin}/monthly/${d.month}\nGhanaWatch, KNUST`,
    990,
  );
  const thread = [
    `${headline}. The ${d.label} Galamsey Index is out. 1/`,
    `${n.districtsAffected} districts saw new mining first seen from space. ${top ? `Rank 1: ${top.name}, ${ha(top.newHa)} ha (${top.index.toFixed(1)} ha per 100 km²).` : ""} 2/`,
    `${since} ${reserves} 3/`,
    river ? `${river.river}: ${river.kmDiscoloured} km of river water turned brown in the same images. 4/` : `Rivers: ${d.rivers.map((r) => `${r.river} ${r.kmDiscoloured} km`).join(", ")}. 4/`,
    `Every number is frozen, measured for accuracy and backed by a page of evidence per site. Method and accuracy: ${origin}/data/methods 5/`,
    `Your district: ${origin}/districts. Full report, PDF and open data: ${origin}/monthly/${d.month} 6/`,
  ];
  return { headline, paragraphs, markdown, docx: docx(headline, paragraphs), whatsapp, thread };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
