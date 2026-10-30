import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import { getDb } from "@/lib/db/client";
import { contextFeatures } from "@/lib/db/schema";
import { districtContaining } from "@/lib/db/repo/boundaries";
import { haversineKm, pointInPolygon } from "@/lib/geo";
import type { GroundPhoto, GroundResponse, NearbyPlace, PlaceKind, StreetImage } from "@/lib/explore/imagery";
import { TtlCache, roundCoord } from "./cache";
import { getJson, isPublicHttpsUrl } from "./fetch";

/**
 * What is on the ground around a spot: mapped schools, cemeteries, clinics and
 * settlements (OpenStreetMap, already in our database), photographs people
 * have published there (Wikimedia Commons), street-level imagery (Panoramax,
 * and Mapillary or Google Street View when this server has their keys).
 * Every provider is optional: one that fails or times out leaves its list empty.
 */
const cache = new TtlCache<GroundResponse>(500, 6 * 3_600_000);

const PLACE_KINDS: PlaceKind[] = ["school", "cemetery", "health", "worship", "settlement"];
const PLACE_RADIUS_M = 3000;
const PHOTO_RADIUS_M = 10_000;
const STREET_RADIUS_M = 1000;

const metres = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => Math.round(haversineKm(a, b) * 1000);

export async function groundAround(lon: number, lat: number): Promise<GroundResponse> {
  const pLon = roundCoord(lon);
  const pLat = roundCoord(lat);
  return cache.get(`${pLon},${pLat}`, async () => {
    const point = { lon: pLon, lat: pLat };
    const notes: string[] = [];
    const settle = async <T>(label: string, p: Promise<T>, empty: T): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        notes.push(`${label} unavailable: ${e instanceof Error ? e.message : String(e)}`);
        return empty;
      }
    };
    const [district, places, protectedArea, photos, panoramax] = await Promise.all([
      settle("District lookup", districtContaining(pLon, pLat), null),
      settle("Mapped places", nearbyPlaces(point), [] as NearbyPlace[]),
      settle("Protected areas", protectedAreaAt(point), null),
      settle("Wikimedia Commons", commonsPhotos(point), [] as GroundPhoto[]),
      settle("Panoramax", panoramaxImages(point), [] as StreetImage[]),
    ]);
    return {
      point,
      place: { district: district?.name ?? null, region: district?.parentName ?? null },
      protectedArea,
      places,
      photos,
      // Only sources that need no key or account: Google Street View is a plain link in the page.
      street: panoramax.sort((a, b) => a.distanceM - b.distanceM).slice(0, 24),
      google: null,
      needsKey: [],
      notes,
    };
  });
}

async function nearbyPlaces(point: { lon: number; lat: number }): Promise<NearbyPlace[]> {
  const db = await getDb();
  const d = 0.03; // about 3.3 km
  const rows = await db
    .select({ kind: contextFeatures.kind, name: contextFeatures.name, lon: contextFeatures.centroidLon, lat: contextFeatures.centroidLat })
    .from(contextFeatures)
    .where(
      and(
        inArray(contextFeatures.kind, PLACE_KINDS),
        gte(contextFeatures.centroidLon, point.lon - d),
        lte(contextFeatures.centroidLon, point.lon + d),
        gte(contextFeatures.centroidLat, point.lat - d),
        lte(contextFeatures.centroidLat, point.lat + d),
      ),
    );
  const perKind = new Map<string, number>();
  return rows
    .map((r) => ({ kind: r.kind as PlaceKind, name: r.name, lon: r.lon, lat: r.lat, distanceM: metres(point, r) }))
    .filter((p) => p.distanceM <= PLACE_RADIUS_M && (p.kind !== "settlement" || p.name))
    .sort((a, b) => a.distanceM - b.distanceM)
    .filter((p) => {
      // Keep the list varied: the nearest few of each kind rather than twenty churches.
      const n = (perKind.get(p.kind) ?? 0) + 1;
      perKind.set(p.kind, n);
      return n <= 6;
    })
    .slice(0, 24);
}

async function protectedAreaAt(point: { lon: number; lat: number }): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .select({ name: contextFeatures.name, geom: contextFeatures.geom })
    .from(contextFeatures)
    .where(
      and(
        eq(contextFeatures.kind, "protected_area"),
        lte(contextFeatures.bboxMinLon, point.lon),
        gte(contextFeatures.bboxMaxLon, point.lon),
        lte(contextFeatures.bboxMinLat, point.lat),
        gte(contextFeatures.bboxMaxLat, point.lat),
      ),
    );
  for (const r of rows) {
    const g = r.geom;
    if (g && (g.type === "Polygon" || g.type === "MultiPolygon") && pointInPolygon([point.lon, point.lat], g as Polygon | MultiPolygon)) {
      return r.name ?? "a protected area";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wikimedia Commons
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Commons metadata is HTML; keep only its text. */
export function plainText(html: unknown, max = 140): string | null {
  if (typeof html !== "string") return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The first date-like value (YYYY, YYYY-MM or YYYY-MM-DD) in a Commons date field. */
export function commonsDate(html: unknown): string | null {
  // Structured dates carry the precise value in a datetime attribute.
  const attr = typeof html === "string" ? html.match(/datetime="((?:1[89]|20)\d{2}(?:-\d{2}){0,2})/)?.[1] : undefined;
  if (attr) return attr;
  const text = plainText(html, 200);
  const m = text?.match(/\b(1[89]\d{2}|20\d{2})(?:[-:](\d{2})(?:[-:](\d{2}))?)?/);
  if (!m) return null;
  return [m[1], m[2], m[3]].filter(Boolean).join("-");
}

const COMMONS_HOSTS = ["https://upload.wikimedia.org/", "https://thumb.wikimedia.org/"];
/** Geotagged files that are not photos taken on the ground there: astronaut and satellite views, maps. */
const NOT_GROUND = /\b(ISS\d{3}-E-\d+|view of earth|sentinel-?\d|landsat|modis|satellite (image|view)|locator map|location map|map of)\b/i;

interface CommonsPage {
  pageid: number;
  title: string;
  coordinates?: Array<{ lat: number; lon: number }>;
  imageinfo?: Array<{
    thumburl?: string;
    responsiveUrls?: Record<string, string>;
    url?: string;
    descriptionurl?: string;
    mime?: string;
    extmetadata?: Record<string, { value?: unknown }>;
  }>;
}

async function commonsPhotos(point: { lon: number; lat: number }): Promise<GroundPhoto[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "geosearch",
    ggscoord: `${point.lat}|${point.lon}`,
    ggsradius: String(PHOTO_RADIUS_M),
    ggsnamespace: "6",
    ggslimit: "40",
    prop: "imageinfo|coordinates",
    iiprop: "url|extmetadata|mime",
    iiurlwidth: "480",
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|DateTimeOriginal|ObjectName",
    format: "json",
    formatversion: "2",
  });
  const json = await getJson<{ query?: { pages?: CommonsPage[] } }>(`https://commons.wikimedia.org/w/api.php?${params}`, { timeoutMs: 8_000 });
  const out: GroundPhoto[] = [];
  for (const p of json.query?.pages ?? []) {
    const info = p.imageinfo?.[0];
    const c = p.coordinates?.[0];
    if (!info || !c || !info.thumburl || !info.url || !info.descriptionurl) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime ?? "")) continue;
    if (!COMMONS_HOSTS.some((h) => info.thumburl!.startsWith(h))) continue;
    const m = info.extmetadata ?? {};
    if (NOT_GROUND.test(p.title) || NOT_GROUND.test(String(m.ObjectName?.value ?? ""))) continue;
    const licenceUrl = typeof m.LicenseUrl?.value === "string" && m.LicenseUrl.value.startsWith("http") ? m.LicenseUrl.value : null;
    out.push({
      id: String(p.pageid),
      title: plainText(m.ObjectName?.value, 100) ?? p.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
      thumbUrl: info.thumburl,
      largeUrl: [info.responsiveUrls?.["2"], info.responsiveUrls?.["1.5"]].find((u) => u && COMMONS_HOSTS.some((h) => u.startsWith(h))) ?? info.thumburl,
      imageUrl: info.url,
      pageUrl: info.descriptionurl,
      author: plainText(m.Artist?.value, 80),
      licence: plainText(m.LicenseShortName?.value, 40),
      licenceUrl,
      takenOn: commonsDate(m.DateTimeOriginal?.value),
      lon: c.lon,
      lat: c.lat,
      distanceM: metres(point, c),
    });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Street-level imagery
// ---------------------------------------------------------------------------

const photoUrl = (src: StreetImage["source"], id: string, size: "thumb" | "full") => `/api/v1/explore/photo?src=${src}&id=${encodeURIComponent(id)}&size=${size}`;

interface PanoramaxFeature {
  id: string;
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown> & { exif?: Record<string, string> };
}

async function panoramaxImages(point: { lon: number; lat: number }): Promise<StreetImage[]> {
  const d = 0.01;
  const url = `https://api.panoramax.xyz/api/search?bbox=${point.lon - d},${point.lat - d},${point.lon + d},${point.lat + d}&limit=50`;
  const json = await getJson<{ features?: PanoramaxFeature[] }>(url, { timeoutMs: 8_000 });
  const out: StreetImage[] = [];
  for (const f of json.features ?? []) {
    const c = f.geometry?.coordinates;
    if (!c || !/^[A-Za-z0-9-]{6,64}$/.test(f.id)) continue;
    const p = f.properties ?? {};
    const distanceM = metres(point, { lon: c[0], lat: c[1] });
    if (distanceM > STREET_RADIUS_M) continue;
    const fov = (p["pers:interior_orientation"] as { field_of_view?: number } | undefined)?.field_of_view;
    out.push({
      id: f.id,
      source: "panoramax",
      isPano: fov === 360 || p.exif?.["Xmp.GPano.ProjectionType"] === "equirectangular",
      takenOn: typeof p.datetime === "string" ? p.datetime.slice(0, 10) : null,
      heading: typeof p["view:azimuth"] === "number" ? (p["view:azimuth"] as number) : null,
      lon: c[0],
      lat: c[1],
      distanceM,
      thumbUrl: photoUrl("panoramax", f.id, "thumb"),
      imageUrl: photoUrl("panoramax", f.id, "full"),
      pageUrl: `https://panoramax.xyz/#focus=pic&pic=${f.id}&map=18/${c[1]}/${c[0]}`,
      author: typeof p["geovisio:producer"] === "string" ? (p["geovisio:producer"] as string) : null,
      licence: typeof p.license === "string" ? p.license : "CC-BY-SA-4.0",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image proxy for street-level photos (same-origin, so the 360° viewer can use them as WebGL textures)
// ---------------------------------------------------------------------------

const resolved = new TtlCache<string>(2000, 6 * 3_600_000);

export async function resolveStreetPhoto(src: StreetImage["source"], id: string, size: "thumb" | "full"): Promise<string> {
  return resolved.get(`${src}:${id}:${size}`, async () => {
    let url: string | undefined;
    if (src === "panoramax") {
      const json = await getJson<{ features?: Array<{ assets?: Record<string, { href?: string }> }> }>(
        `https://api.panoramax.xyz/api/search?ids=${encodeURIComponent(id)}&limit=1`,
        { timeoutMs: 8_000 },
      );
      const assets = json.features?.[0]?.assets ?? {};
      url = size === "thumb" ? assets.thumb?.href : (assets.sd?.href ?? assets.hd?.href);
    } else {
      throw new Error("Unknown photo source");
    }
    if (!url || !isPublicHttpsUrl(url)) throw new Error("No image for this photo");
    return url;
  });
}
