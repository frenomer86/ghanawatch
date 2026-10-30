import { GHANA_BBOX } from "@/lib/domain/types";
import { firePoints } from "@/lib/db/schema";
import { squareAround } from "@/lib/geo";
import { DistrictIndex, loadDistricts } from "../districts";
import type { Adapter, NormalisedEvent } from "./types";

/**
 * NASA FIRMS active fire detections, VIIRS 375 m, from three satellites
 * (Suomi NPP, NOAA-20, NOAA-21).
 *
 * Source: the public, keyless regional files that FIRMS republishes every few
 * hours: https://firms.modaps.eosdis.nasa.gov/active_fire/
 * (Northern and Central Africa region, last 7 days). The adapter keeps rows
 * inside Ghana's bounding box; the runner then drops anything whose centroid
 * is not inside a Ghanaian district.
 *
 * Processing:
 *  - Detections from all satellites on the same day inside the same ~550 m
 *    cell are merged into one event (one fire, several looks).
 *  - Cells with detections on 4 or more distinct days in the 7-day window are
 *    treated as persistent heat sources (gas flares, industrial plants) and
 *    excluded, as FIRMS itself recommends for non-vegetation fires.
 */
const FEEDS = [
  { sat: "Suomi NPP", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Northern_and_Central_Africa_7d.csv" },
  { sat: "NOAA-20", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Northern_and_Central_Africa_7d.csv" },
  { sat: "NOAA-21", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Northern_and_Central_Africa_7d.csv" },
];

const CELL = 0.005; // degrees, about 550 m
const PERSISTENT_DAYS = 4;

interface Det {
  lat: number;
  lon: number;
  at: Date;
  date: string;
  time: string;
  sat: string;
  conf: "low" | "medium" | "high";
  frp: number;
  dayNight: string;
}

export const firmsAdapter: Adapter = {
  slug: "nasa-firms",
  async run(ctx) {
    const [minLon, minLat, maxLon, maxLat] = GHANA_BBOX;
    const dets: Det[] = [];
    const notes: string[] = [];
    let feedsOk = 0;
    for (const feed of FEEDS) {
      let csv: string;
      try {
        csv = await ctx.fetchText(feed.url);
        feedsOk++;
      } catch (err) {
        notes.push(`${feed.sat}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const r of parseCsv(csv)) {
        const lat = Number(r.latitude);
        const lon = Number(r.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        const time = String(r.acq_time ?? "0000").padStart(4, "0");
        const at = new Date(`${r.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
        if (Number.isNaN(at.getTime())) continue;
        const c = String(r.confidence ?? "n").toLowerCase();
        dets.push({
          lat,
          lon,
          at,
          date: r.acq_date,
          time,
          sat: feed.sat,
          conf: c.startsWith("h") ? "high" : c.startsWith("l") ? "low" : "medium",
          frp: Number(r.frp ?? 0) || 0,
          dayNight: r.daynight,
        });
      }
    }
    if (feedsOk === 0) throw new Error(`No FIRMS feed could be read. ${notes.join("; ")}`);

    // Persistent heat sources: same cell seen on many distinct days.
    const cellKey = (d: Det) => `${Math.floor(d.lat / CELL)}:${Math.floor(d.lon / CELL)}`;
    const daysPerCell = new Map<string, Set<string>>();
    for (const d of dets) {
      const k = cellKey(d);
      if (!daysPerCell.has(k)) daysPerCell.set(k, new Set());
      daysPerCell.get(k)!.add(d.date);
    }
    const persistent = new Set([...daysPerCell].filter(([, days]) => days.size >= PERSISTENT_DAYS).map(([k]) => k));

    // One event per cell per day.
    const groups = new Map<string, Det[]>();
    for (const d of dets) {
      const k = cellKey(d);
      if (persistent.has(k)) continue;
      const g = `${k}:${d.date}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(d);
    }

    const order = { low: 0, medium: 1, high: 2 } as const;
    const events: NormalisedEvent[] = [];
    let watermark: Date | undefined;
    for (const [key, g] of groups) {
      g.sort((a, b) => a.at.getTime() - b.at.getTime());
      const first = g[0];
      const last = g[g.length - 1];
      const lat = g.reduce((s, d) => s + d.lat, 0) / g.length;
      const lon = g.reduce((s, d) => s + d.lon, 0) / g.length;
      const maxFrp = Math.max(...g.map((d) => d.frp));
      const conf = g.reduce<Det["conf"]>((m, d) => (order[d.conf] > order[m] ? d.conf : m), "low");
      const sats = [...new Set(g.map((d) => d.sat))];
      // Seen by two or more satellites or passes raises confidence by one step.
      const confidence = g.length >= 2 && conf !== "high" ? (conf === "low" ? "medium" : "high") : conf;
      events.push({
        sourceSlug: "nasa-firms",
        sourceEventId: `viirs-${key}`,
        type: "fire",
        detectedAt: last.at,
        imageDate: first.date,
        imageDateEnd: last.date !== first.date ? last.date : null,
        confidence,
        confidenceScore: confidence === "high" ? 0.9 : confidence === "medium" ? 0.65 : 0.4,
        severity: maxFrp >= 50 || g.length >= 6 ? "elevated" : maxFrp >= 15 || g.length >= 3 ? "watch" : "normal",
        areaHa: 14 * Math.min(g.length, 4),
        geom: squareAround({ lon, lat }, 375),
        titleEn: "Active fire detected",
        titleTw: "Ogya a ɛredɛre",
        descriptionEn: `${g.length} VIIRS thermal detection${g.length === 1 ? "" : "s"} by ${sats.join(", ")} between ${fmt(first)} and ${fmt(last)} UTC. Highest fire radiative power ${maxFrp.toFixed(1)} MW. A thermal anomaly is consistent with open burning (bush, farm or waste fires); the cause is not determined from satellite data. Persistent industrial heat sources are excluded.`,
        descriptionTw: "Satellite hunuu ogya ho nsɛnkyerɛnne wɔ beaeɛ yi. Ɛnkyerɛ deɛ ɛde ogya no baeɛ.",
        methodVersion: "firms-viirs-1.1",
        properties: { detections: g.length, satellites: sats, maxFrp, dayNight: [...new Set(g.map((d) => d.dayNight))] },
        images: [{ role: "latest", sourceSlug: "nasa-firms", sensor: `VIIRS (${sats.join(", ")})`, acquiredAt: last.at, licence: "NASA open data" }],
      });
      if (!watermark || last.at > watermark) watermark = last.at;
    }
    // Keep the fire archive (fire_points) growing from the live feed: Suomi NPP only,
    // like the yearly archive files, without low confidence or persistent sources.
    if (ctx.db) {
      const rows = dets
        .filter((d) => d.sat === "Suomi NPP" && d.conf !== "low" && !persistent.has(cellKey(d)))
        .map((d) => ({
          lon: Number(d.lon.toFixed(5)),
          lat: Number(d.lat.toFixed(5)),
          acqDate: d.date,
          acqTime: d.time,
          confidence: d.conf === "high" ? "h" : "n",
          frp: d.frp || null,
          source: "firms-live",
        }));
      const districts = new DistrictIndex(await loadDistricts(ctx.db));
      const placed = rows.map((r) => ({ ...r, districtId: districts.find(r.lon, r.lat)?.id ?? null }));
      for (let i = 0; i < placed.length; i += 2000) await ctx.db.insert(firePoints).values(placed.slice(i, i + 2000)).onConflictDoNothing();
    }
    if (persistent.size) notes.push(`${persistent.size} persistent heat-source cells excluded`);
    ctx.log(`nasa-firms: ${dets.length} detections in Ghana box, ${persistent.size} persistent cells excluded, ${events.length} events`);
    return { events, watermark, notes };
  },
};

function fmt(d: Det) {
  return `${d.date} ${d.time.slice(0, 2)}:${d.time.slice(2)}`;
}

/** Minimal RFC-4180 CSV parser (quoted fields, no embedded newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = splitLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitLine(l);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}
