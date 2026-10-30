import { sql } from "drizzle-orm";
import { adminBoundaries, newsSignals } from "@/lib/db/schema";
import { stableId } from "@/lib/server/ids";
import { rows as toRows, type Db } from "@/lib/db/client";
import type { Adapter } from "./types";

/**
 * Hidden input from public news and disaster feeds. Never shown on public pages.
 *
 * Reads the public RSS feeds of Ghanaian outlets and the GDACS disaster feed (no key, no account), keeps
 * items about galamsey, floods, fires, dam spills, oil spills, building collapses and power cuts, and finds
 * the Ghanaian place named in the text using GhanaWatch's own place list (OpenStreetMap places and district
 * names, offline). Only headline and summary text is read; no photo is downloaded or stored.
 *
 * What a signal does: it asks for a targeted satellite re-check of the scan cells around the place, and it
 * can raise a medium-confidence detection of the same kind nearby to high (two independent sources). It
 * never creates a detection by itself: a story names a town, not a pit.
 */
const SLUG = "news-signals";
const FEEDS = [
  { source: "MyJoyOnline", url: "https://www.myjoyonline.com/feed/" },
  { source: "Graphic Online", url: "https://www.graphic.com.gh/news.feed?type=rss" },
  { source: "3News", url: "https://3news.com/feed/" },
  { source: "Adom Online", url: "https://www.adomonline.com/feed/" },
  { source: "Ghanaian Times", url: "https://www.ghanaiantimes.com.gh/feed/" },
  { source: "The High Street Journal", url: "https://thehighstreetjournal.com/feed/" },
  // Topic feeds (public WordPress tag feeds) reach further back than the front-page feeds.
  { source: "MyJoyOnline", url: "https://www.myjoyonline.com/tag/galamsey/feed/" },
  { source: "MyJoyOnline", url: "https://www.myjoyonline.com/tag/floods/feed/" },
  { source: "3News", url: "https://3news.com/tag/galamsey/feed/" },
  { source: "3News", url: "https://3news.com/tag/flood/feed/" },
  { source: "Adom Online", url: "https://www.adomonline.com/tag/galamsey/feed/" },
  { source: "Adom Online", url: "https://www.adomonline.com/tag/flood/feed/" },
  { source: "The High Street Journal", url: "https://thehighstreetjournal.com/tag/galamsey/feed/" },
  { source: "GDACS", url: "https://www.gdacs.org/xml/rss.xml" },
];
const MAX_AGE_DAYS = 30;
/** Radius around the place, in degrees (about 6 km), for re-checks and corroboration. */
const NEAR = 0.055;

export const EVENT_TYPES = ["galamsey", "flood", "fire", "dam_spill", "oil_spill", "collapse", "power_cut"] as const;
export type NewsEvent = (typeof EVENT_TYPES)[number];

const PATTERNS: Array<[NewsEvent, RegExp]> = [
  ["galamsey", /\bgalamsey\b|illegal (small[- ]scale )?mining|illegal miners?|chanfan|changfan|mining pits?|excavators? (seized|burnt|impounded)/i],
  ["dam_spill", /\b(bagre|akosombo|kpong|weija|bui)\b.{0,40}\bspill|\bspill(age|ing)?\b.{0,40}\bdam\b|dam spill/i],
  ["flood", /\bflood(s|ed|ing)?\b|submerged|washed away/i],
  ["fire", /\b(bush ?fire|wild ?fire|fire (outbreak|guts|destroys|razes)|gutted by fire|razed)\b/i],
  ["oil_spill", /\boil spill\b/i],
  ["collapse", /\b(building|storey|bridge) collapse|collapsed? (building|bridge)\b/i],
  ["power_cut", /\bdumsor\b|power (outage|cut)s?|load[- ]shedding|blackout/i],
];

interface Item {
  source: string;
  url: string;
  title: string;
  text: string;
  publishedAt: Date | null;
}

interface Place {
  name: string;
  kind: "district" | "settlement";
  districtId: string | null;
  lon: number;
  lat: number;
  re: RegExp;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

/** Items from an RSS document (plain text of title and summary only). Pure; exported for tests. */
export function parseRss(xml: string, source: string): Item[] {
  return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []).map((it) => {
    const date = tag(it, "pubDate") || tag(it, "dc:date");
    const d = date ? new Date(date) : null;
    return {
      source,
      url: tag(it, "link") || tag(it, "guid"),
      title: tag(it, "title"),
      text: `${tag(it, "title")}. ${tag(it, "description")}`.slice(0, 2000),
      publishedAt: d && !Number.isNaN(d.getTime()) ? d : null,
    };
  });
}

export function classifyText(text: string): NewsEvent | null {
  return matchEvent(text)?.type ?? null;
}

/** The event named in the text and where the words are, so the place can be looked for next to them. */
export function matchEvent(text: string): { type: NewsEvent; index: number } | null {
  for (const [type, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) return { type, index: m.index };
  }
  return null;
}

/** Campaigns, awards, opinion and politics about an issue are not reports of it happening somewhere. */
const NOT_AN_EVENT = /(campaign|award|wins|webinar|conference|summit|documentary|playback|podcast|opinion|editorial|anniversary)/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function loadPlaces(db: Db): Promise<Place[]> {
  const districts = await db
    .select({ id: adminBoundaries.id, name: adminBoundaries.name, lon: adminBoundaries.centroidLon, lat: adminBoundaries.centroidLat })
    .from(adminBoundaries)
    .where(sql`${adminBoundaries.level} = 'district'`);
  const towns = toRows<{ name: string; lon: number; lat: number }>(
    await db.execute(sql`select distinct on (lower(name)) name, centroid_lon::float lon, centroid_lat::float lat from context_features where kind = 'settlement' and name is not null`),
  );
  const out: Place[] = [];
  const add = (name: string, kind: Place["kind"], districtId: string | null, lon: number, lat: number) => {
    const n = name.trim();
    // Short or common-word names match too much text; keep distinctive names only.
    if (n.length < 5 || /^(central|north|south|east|west|market|junction|station|new town|zongo)$/i.test(n)) return;
    out.push({ name: n, kind, districtId, lon, lat, re: new RegExp(`(^|[^\\p{L}])${escape(n)}([^\\p{L}]|$)`, "u") });
  };
  for (const d of districts) {
    if (d.lon == null || d.lat == null) continue;
    add(d.name, "district", d.id, d.lon, d.lat);
    const short = d.name.replace(/\s+(Municipal|Metropolis|Metropolitan|District)$/i, "");
    if (short !== d.name) add(short, "district", d.id, d.lon, d.lat);
  }
  for (const t of towns) add(t.name, "settlement", null, t.lon, t.lat);
  // Longest names first, so "Prestea Huni Valley" wins over "Prestea".
  return out.sort((a, b) => b.name.length - a.name.length);
}

/**
 * The first place named as a location: a district name, or a town written after "in", "at", "near", "around",
 * "along" or "from" (not "of": "University of Cape Coast" is not a place report), or followed by a word like "community" or "residents". A town name on its own is often a
 * person's or an organisation's name ("Christian Council", "Mr Dankwa"), so it does not count.
 */
export function findPlace(text: string, places: Array<Pick<Place, "name" | "re"> & { kind?: Place["kind"] }>, strict = false): number {
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const m = p.re.exec(text);
    if (!m) continue;
    // In a headline a district name is the place; deeper in the text it may be where a speech was given.
    if (p.kind === "district" && !strict) return i;
    const at = m.index + m[1].length;
    const before = text.slice(Math.max(0, at - 16), at);
    const after = text.slice(at + p.name.length, at + p.name.length + 24);
    if (
      /\b(in|at|near|around|along|from)\s+(the\s+)?$/i.test(before) ||
      /^\s*(community|communities|residents|township|area|district|municipal|stream|river|forest|enclave|roads?)\b/i.test(after)
    )
      return i;
  }
  return -1;
}

export const newsSignalsAdapter: Adapter = {
  slug: SLUG,
  minIntervalHours: 2,
  async run(ctx) {
    const db = ctx.db;
    if (!db) throw new Error(`${SLUG} needs the database`);
    const places = await loadPlaces(db);
    const since = ctx.now.getTime() - MAX_AGE_DAYS * 86_400_000;
    const notes: string[] = [];
    let read = 0;
    let relevant = 0;
    let located = 0;
    let fresh = 0;
    for (const feed of FEEDS) {
      let items: Item[];
      try {
        items = parseRss(await ctx.fetchText(feed.url), feed.source);
      } catch (e) {
        notes.push(`${feed.source}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // GDACS covers the world; keep only items about Ghana.
      if (feed.source === "GDACS") items = items.filter((i) => /\bghana\b/i.test(i.text));
      read += items.length;
      for (const it of items) {
        if (!it.url || (it.publishedAt && it.publishedAt.getTime() < since)) continue;
        // The event must be in the headline, and the place in the headline or right next to the event words.
        const ev = matchEvent(it.title);
        if (!ev || NOT_AN_EVENT.test(it.title)) continue;
        const type = ev.type;
        relevant++;
        const at = it.text.search(PATTERNS.find(([t]) => t === type)![1]);
        const near = it.text.slice(Math.max(0, at - 200), at + 250);
        let pi = findPlace(it.title, places);
        if (pi < 0) pi = findPlace(near, places, true);
        const p = pi >= 0 ? places[pi] : null;
        if (p) located++;
        const id = stableId("news", `${it.url}:${type}`);
        const res = await db
          .insert(newsSignals)
          .values({
            id,
            source: it.source,
            url: it.url.slice(0, 1000),
            title: it.title.slice(0, 300),
            publishedAt: it.publishedAt,
            eventType: type,
            placeName: p?.name ?? null,
            placeKind: p?.kind ?? null,
            districtId: p?.districtId ?? null,
            lon: p?.lon ?? null,
            lat: p?.lat ?? null,
            // A district centre is vaguer than a named town.
            confidence: p ? (p.kind === "settlement" ? 0.6 : 0.4) : 0.2,
          })
          .onConflictDoNothing()
          .returning();
        if (res.length) fresh++;
      }
    }
    const effects = await applySignals(db, ctx.now);
    ctx.log(
      `${SLUG}: ${read} items read, ${relevant} about events, ${located} placed in Ghana, ${fresh} new; ${effects.cells} cells queued for re-check, ${effects.corroborated} detections backed up`,
    );
    return { events: [], notes, extra: { read, relevant, located, fresh, ...effects } };
  },
};

/**
 * Act on located signals from the last 30 days: queue the scan cells around each place for a re-check (once
 * per signal), and raise medium-confidence detections of the same kind within about 6 km to high.
 */
export async function applySignals(db: Db, now: Date): Promise<{ cells: number; corroborated: number }> {
  const pending = toRows<{ id: string; lon: number; lat: number; event_type: NewsEvent }>(
    await db.execute(sql`
      select id::text, lon::float, lat::float, event_type from news_signals
      where lon is not null and not (triggered ? 'recheckCells') and coalesce(published_at, created_at) >= now() - interval '30 days'`),
  );
  let cells = 0;
  for (const s of pending) {
    // Galamsey and floods have a satellite re-check; fires, power cuts and the rest are recorded only.
    const ids =
      s.event_type === "galamsey" || s.event_type === "flood" || s.event_type === "dam_spill"
        ? toRows<{ id: string }>(
            await db.execute(sql`
              update analysis_cells set recheck_requested_at = ${now.toISOString()}::timestamptz
              where min_lon <= ${s.lon + NEAR} and max_lon >= ${s.lon - NEAR} and min_lat <= ${s.lat + NEAR} and max_lat >= ${s.lat - NEAR}
              returning id`),
          ).map((r) => r.id)
        : [];
    cells += ids.length;
    await db.execute(sql`
      update news_signals set triggered = triggered || jsonb_build_object('recheckCells', ${JSON.stringify(ids)}::text::jsonb, 'recheckAt', ${now.toISOString()}::text)
      where id = ${s.id}::uuid`);
  }
  const corr = toRows<{ n: number }>(
    await db.execute(sql`
      with s as (
        select id, lon, lat, event_type from news_signals
        where lon is not null and event_type = 'galamsey' and coalesce(published_at, created_at) >= now() - interval '60 days'
      ), up as (
        update change_events e set confidence = 'high',
          confidence_score = greatest(coalesce(e.confidence_score, 0), 0.85),
          properties = e.properties || jsonb_build_object('newsSignal', (select s.id::text from s
            where e.centroid_lon between s.lon - ${NEAR} and s.lon + ${NEAR} and e.centroid_lat between s.lat - ${NEAR} and s.lat + ${NEAR} limit 1))
        where e.status <> 'dismissed' and e.confidence = 'medium' and not (e.properties ? 'newsSignal')
          and ((e.method_version like 's2-galamsey-%' and e.type = 'surface_disturbance') or e.method_version like 's1-water-%')
          and exists (select 1 from s where e.centroid_lon between s.lon - ${NEAR} and s.lon + ${NEAR} and e.centroid_lat between s.lat - ${NEAR} and s.lat + ${NEAR})
        returning e.id
      ) select count(*)::int n from up`),
  );
  return { cells, corroborated: corr[0]?.n ?? 0 };
}
