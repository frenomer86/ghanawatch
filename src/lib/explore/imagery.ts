import type { SightingKind, SightingStatus } from "@/lib/domain/types";

/**
 * Imagery layers and outbound links for Ground view. Shared by the server
 * routes and the client viewer, so nothing here may touch the server
 * environment. Every layer is a public, keyless service, and every one is
 * shown with its own capture date and credit.
 */

/** Mapzen/Tilezen terrain tiles on AWS Open Data, terrarium-encoded elevation. */
export const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_ATTRIBUTION = "Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1)";

/**
 * Esri World Imagery, served from the Wayback archive so every release has a
 * fixed number and a metadata layer giving the capture date at any point.
 */
export const waybackTiles = (release: number) =>
  `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${release}/{z}/{y}/{x}`;
/**
 * Deepest tile level worth asking for. Esri publishes it per capture; without
 * it, go by resolution (a 1 m capture has nothing more to show past level 17).
 */
export function maxTileZoom(capture: Pick<HighResCapture, "resolutionM" | "maxLevel"> | null): number {
  if (capture?.maxLevel && capture.maxLevel >= 10 && capture.maxLevel <= 23) return capture.maxLevel;
  const r = capture?.resolutionM;
  if (r == null) return 18;
  if (r <= 0.6) return 18;
  if (r <= 1.2) return 17;
  return 16;
}

/** The live World Imagery service, shown while the dated Wayback captures are looked up. */
export const WORLD_IMAGERY_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const ESRI_ATTRIBUTION = "Powered by Esri. Imagery: Esri, Vantor, Earthstar Geographics and the GIS User Community";

/** EOX Sentinel-2 cloudless: one cloud-free 10 m mosaic of the whole country per year. */
export const annualMosaicTiles = (year: number) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/g/{z}/{y}/{x}.jpg`;
/** One credit for every year, so the map shows it once however many years are loaded. */
export const MOSAIC_ATTRIBUTION = "Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data), CC BY-NC-SA 4.0";
/** Below this resolution a "capture" is a regional base layer, not a close-up worth listing. */
export const MAX_CLOSEUP_RES_M = 5;
/** Earlier mosaics are hazy or missing over Ghana. */
export const FIRST_MOSAIC_YEAR = 2018;

export const OSM_TILEJSON = "https://tiles.openfreemap.org/planet";
export const OSM_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const OSM_ATTRIBUTION = "Labels: © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap";

/** Half the side of the square drawn for each single Sentinel-2 pass, in metres. */
export const PASS_HALF_SIZE_M = 2000;

export interface HighResCapture {
  /** Wayback release whose tiles show this capture at the point. */
  release: number;
  releaseDate: string | null;
  capturedOn: string | null;
  provider: string | null;
  sensor: string | null;
  resolutionM: number | null;
  /** Deepest tile level Esri serves for this capture (MaxMapLevel in the metadata). */
  maxLevel: number | null;
}

export interface PassFrame {
  scene: string;
  date: string;
  /** Cloud over the whole 110 km Sentinel-2 tile; the local check happens when the frame is drawn. */
  tileCloud: number;
  url: string;
  /** Corners of the drawn square: top-left, top-right, bottom-right, bottom-left, as [lon, lat]. */
  corners: [[number, number], [number, number], [number, number], [number, number]];
}

export interface ImageryResponse {
  point: { lon: number; lat: number };
  highRes: HighResCapture[];
  annualYears: number[];
  notes: string[];
}

export interface PassesResponse {
  point: { lon: number; lat: number };
  passes: PassFrame[];
  notes: string[];
}

export type PlaceKind = "school" | "cemetery" | "health" | "worship" | "settlement";

export interface NearbyPlace {
  kind: PlaceKind;
  name: string | null;
  lon: number;
  lat: number;
  distanceM: number;
}

export interface GroundPhoto {
  id: string;
  title: string;
  thumbUrl: string;
  /** About 960 px wide, for the lightbox. */
  largeUrl: string;
  imageUrl: string;
  pageUrl: string;
  author: string | null;
  licence: string | null;
  licenceUrl: string | null;
  takenOn: string | null;
  lon: number;
  lat: number;
  distanceM: number;
}

export interface StreetImage {
  id: string;
  source: "mapillary" | "panoramax";
  isPano: boolean;
  takenOn: string | null;
  heading: number | null;
  lon: number;
  lat: number;
  distanceM: number;
  thumbUrl: string;
  imageUrl: string;
  pageUrl: string;
  author: string | null;
  licence: string;
}

export interface GoogleStreetView {
  panoId: string;
  date: string | null;
  lon: number;
  lat: number;
  distanceM: number;
  embedUrl: string;
}

export interface GroundResponse {
  point: { lon: number; lat: number };
  place: { district: string | null; region: string | null };
  protectedArea: string | null;
  places: NearbyPlace[];
  photos: GroundPhoto[];
  street: StreetImage[];
  google: GoogleStreetView | null;
  /** Street-level providers that are built but need a key on this server. */
  needsKey: string[];
  notes: string[];
}

/** A machine tagged on a dated close-up (see machinery_sightings). */
export interface Sighting {
  id: string;
  kind: SightingKind;
  /** esri-world-imagery for tags on close-ups; sentinel-1 for radar reflections flagged on rivers. */
  source: string;
  count: number;
  lon: number;
  lat: number;
  release: number | null;
  capturedOn: string | null;
  sensor: string | null;
  status: SightingStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  distanceM?: number;
}

/** Google's documented Maps URL for Street View at a point; opens the nearest panorama. */
export function googleStreetViewUrl(lat: number, lon: number) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** Google Earth on the web, looking down at the point at an angle from about 1.2 km away. */
export function googleEarthUrl(lat: number, lon: number) {
  return `https://earth.google.com/web/@${lat.toFixed(6)},${lon.toFixed(6)},250a,1200d,35y,0h,55t,0r`;
}

/**
 * Newer pictures elsewhere. These providers' terms let us link to their own
 * sites but not show, store or analyse their imagery, so Ground view only
 * links out (documented URL formats for each).
 */
export function googleMapsSatelliteUrl(lat: number, lon: number) {
  return `https://www.google.com/maps/@?api=1&map_action=map&center=${lat.toFixed(6)},${lon.toFixed(6)}&zoom=19&basemap=satellite`;
}

export function bingAerialUrl(lat: number, lon: number) {
  return `https://www.bing.com/maps?cp=${lat.toFixed(6)}~${lon.toFixed(6)}&lvl=19&style=a`;
}

export function appleMapsSatelliteUrl(lat: number, lon: number) {
  return `https://maps.apple.com/?ll=${lat.toFixed(6)},${lon.toFixed(6)}&z=19&t=k`;
}

export function openStreetMapUrl(lat: number, lon: number) {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}

/** Link to Ground view for a point, optionally carrying the detection, a view and a close-up release. */
export function groundViewHref(lat: number, lon: number, eventId?: string | null, opts: { mode?: "machinery"; release?: number | null } = {}) {
  const sp = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5) });
  if (eventId) sp.set("event", eventId);
  if (opts.mode) sp.set("mode", opts.mode);
  if (opts.release) sp.set("release", String(opts.release));
  return `/explore?${sp.toString()}`;
}
