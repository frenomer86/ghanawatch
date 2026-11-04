/**
 * Domain vocabulary shared by the pipeline, the API and the UI.
 * Keep this file free of DB and HTTP imports.
 */

export const CHANGE_TYPES = [
  "vegetation_loss",
  "surface_disturbance",
  "water_change",
  "flood_risk",
  "fire",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** SRS §10.3 risk levels. "urgent" is used sparingly. */
export const SEVERITIES = ["normal", "watch", "elevated", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EVENT_STATUSES = ["new", "reviewed", "dismissed", "verified"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Where a report's position came from: the photo's own GPS, the phone's location, or a pin on the map. */
export const LOCATION_SOURCES = ["photo", "device", "pin"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/** "unverified": closed automatically after 30 days with nothing to confirm it (src/lib/domain/auto-review.ts). */
export const REPORT_STATUSES = ["pending", "approved", "rejected", "needs_info", "unverified"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What a member of the public is reporting. */
export const REPORT_CATEGORIES = ["galamsey", "dumping", "fire", "flooding", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** The public case trail of a report: what has happened since it was sent. */
export const CASE_STATUSES = ["reported", "confirmed", "passed_to_authority", "action_seen", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** A moderator's reading of the satellite evidence for a report. */
export const SATELLITE_VERDICTS = ["under_review", "confirmed_by_satellite", "not_visible_yet"] as const;
export type SatelliteVerdict = (typeof SATELLITE_VERDICTS)[number];

/** Bodies a confirmed case can be passed to. */
export const AUTHORITIES = [
  "minerals_commission",
  "epa",
  "forestry_commission",
  "water_resources_commission",
  "police",
  "district_assembly",
  "other",
] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** What people can tag on a close-up in Ground view. */
export const SIGHTING_KINDS = ["excavator", "truck", "washing_plant", "dredger", "other"] as const;
export type SightingKind = (typeof SIGHTING_KINDS)[number];

export const SIGHTING_STATUSES = ["pending", "confirmed", "rejected"] as const;
export type SightingStatus = (typeof SIGHTING_STATUSES)[number];

export const LOCALES = ["en", "tw"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const SOURCE_CATEGORIES = [
  "imagery",
  "alerts",
  "fire",
  "flood",
  "weather",
  "water",
  "boundaries",
  "protected-areas",
  "basemap",
  "platform",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/** Ghana bounding box with a small margin, WGS84 [minLon, minLat, maxLon, maxLat]. */
export const GHANA_BBOX = [-3.4, 4.6, 1.3, 11.3] as const;
export type BBox = [number, number, number, number];

export const GHANA_CENTER = { lon: -1.05, lat: 7.95 } as const;

/** 72-hour window the SRS uses for "new" detections on the map. */
export const NEW_WINDOW_HOURS = 72;

/** Data considered stale after this many hours without a successful pipeline run. */
export const STALE_AFTER_HOURS = 48;

export interface ChangeEventSummary {
  id: string;
  type: ChangeType;
  severity: Severity;
  confidence: Confidence;
  detectedAt: string; // ISO timestamp
  imageDate: string; // ISO date (YYYY-MM-DD)
  imageDateEnd?: string | null;
  areaHa: number | null;
  districtName: string | null;
  regionName: string | null;
  centroid: { lon: number; lat: number };
  title: string;
  sourceSlug: string;
  sourceName: string;
  status: EventStatus;
  /** Where it is: inside a reserve or residential area, distance to a school, etc. */
  flags: string[];
}

export interface ImageReference {
  role: "latest" | "before" | "after";
  productId: string | null;
  sensor: string | null;
  acquiredAt: string;
  cloudCoverPct: number | null;
  thumbnailUrl: string | null;
  licence: string | null;
  sourceName: string;
}

export interface ChangeEventDetail extends ChangeEventSummary {
  description: string;
  geometry: GeoJSON.Geometry;
  bbox: BBox;
  methodVersion: string | null;
  images: ImageReference[];
  sourceUrl: string;
  sourceLicence: string;
  sourceAttribution: string;
  citation: string;
}

export interface HotspotSummary {
  id: string;
  type: ChangeType;
  severity: Severity;
  eventCount: number;
  areaHaTotal: number | null;
  isNew: boolean;
  districtName: string | null;
  regionName: string | null;
  centroid: { lon: number; lat: number };
  windowStart: string;
  windowEnd: string;
  label: string;
}

export interface DataFreshness {
  lastSuccessfulRunAt: string | null;
  latestImageDate: string | null;
  isStale: boolean;
  perSource: Array<{ slug: string; name: string; lastRunAt: string | null; status: string }>;
}
