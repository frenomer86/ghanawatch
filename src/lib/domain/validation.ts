import { z } from "zod";
import {
  AUTHORITIES,
  CHANGE_TYPES,
  CONFIDENCES,
  GHANA_BBOX,
  LOCALES,
  LOCATION_SOURCES,
  REPORT_CATEGORIES,
  SATELLITE_VERDICTS,
  SEVERITIES,
  SIGHTING_KINDS,
  type BBox,
} from "./types";

/**
 * One Zod schema per input surface. Every API route parses with these and
 * nothing else reaches a repository. All schemas are `.strict()` so unknown
 * keys are rejected rather than silently ignored.
 */

const lon = z.coerce.number().min(-180).max(180);
const lat = z.coerce.number().min(-90).max(90);

/** Clamp any bbox to Ghana so a world-sized request cannot scan the whole table. */
export function clampBBox(b: BBox): BBox {
  const [gMinLon, gMinLat, gMaxLon, gMaxLat] = GHANA_BBOX;
  return [
    Math.max(b[0], gMinLon),
    Math.max(b[1], gMinLat),
    Math.min(b[2], gMaxLon),
    Math.min(b[3], gMaxLat),
  ];
}

export const bboxParam = z
  .string()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, "bbox must be minLon,minLat,maxLon,maxLat")
  .transform((s) => s.split(",").map(Number) as BBox)
  .refine((b) => b[0] < b[2] && b[1] < b[3], "bbox min must be less than max")
  .transform(clampBBox);

export const uuidParam = z.string().uuid();

/** Cursor is the (detected_at, id) pair of the last row, base64url-encoded. */
export const cursorParam = z
  .string()
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/)
  .transform((s, ctx) => {
    try {
      const decoded = Buffer.from(s, "base64url").toString("utf8");
      const [ts, id] = decoded.split("|");
      const parsed = z.object({ ts: z.string().datetime(), id: z.string().uuid() }).parse({ ts, id });
      return parsed;
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid cursor" });
      return z.NEVER;
    }
  });

export const encodeCursor = (ts: Date, id: string) =>
  Buffer.from(`${ts.toISOString()}|${id}`, "utf8").toString("base64url");

/** A real calendar date, not just the shape of one: 2026-13-99 is refused before it reaches the database. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a calendar date");

export const eventsQuery = z
  .object({
    bbox: bboxParam.optional(),
    since: z.coerce.date().max(new Date(Date.now() + 86_400_000), "since cannot be in the future").optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    type: z.enum(CHANGE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    /** 1 also returns low-confidence ("possible") detections; downloads always include them, labelled. */
    possible: z.enum(["0", "1"]).optional(),
    region: z.string().min(1).max(80).optional(),
    district: z.string().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: cursorParam.optional(),
    format: z.enum(["json", "geojson", "csv"]).default("json"),
    lang: z.enum(LOCALES).optional(),
  })
  .strict();
export type EventsQuery = z.infer<typeof eventsQuery>;

export const hotspotsQuery = z
  .object({
    bbox: bboxParam.optional(),
    type: z.enum(CHANGE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    hours: z.coerce.number().int().min(1).max(24 * 365).default(72),
    /** 1 also counts low-confidence ("possible") detections. */
    possible: z.enum(["0", "1"]).optional(),
    lang: z.enum(LOCALES).optional(),
  })
  .strict();
export type HotspotsQuery = z.infer<typeof hotspotsQuery>;

/** A point in Ghana (with a margin), for Ground view lookups. */
const ghanaLon = z.coerce.number().min(GHANA_BBOX[0] - 0.5).max(GHANA_BBOX[2] + 0.5);
const ghanaLat = z.coerce.number().min(GHANA_BBOX[1] - 0.5).max(GHANA_BBOX[3] + 0.5);

export const explorePointQuery = z.object({ lon: ghanaLon, lat: ghanaLat }).strict();

/** A plot for "Check this land": a pin and a radius in metres. */
export const landQuery = z
  .object({
    lat: ghanaLat,
    lon: ghanaLon,
    r: z.coerce.number().int().min(25).max(1000).default(100),
  })
  .strict();

export const landImageQuery = z
  .object({
    lat: ghanaLat,
    lon: ghanaLon,
    r: z.coerce.number().int().min(25).max(1000).default(100),
    layer: z.enum(["before", "after", "closeup"]),
  })
  .strict();

/** Sentinel-2 L2A scene id as published by Earth Search, e.g. S2B_30NWM_20261002_0_L2A. */
export const SCENE_ID_RE = /^S2[A-D]_(\d{2})([C-X])([A-Z]{2})_(\d{4})(\d{2})(\d{2})_(\d)_L2A$/;

export const passQuery = z.object({ scene: z.string().max(40).regex(SCENE_ID_RE), lon: ghanaLon, lat: ghanaLat }).strict();

export const streetPhotoQuery = z
  .object({
    src: z.enum(["panoramax"]),
    id: z.string().regex(/^[A-Za-z0-9-]{6,64}$/),
    size: z.enum(["thumb", "full"]).default("thumb"),
  })
  .strict();

/** A machine someone saw on a dated close-up in Ground view. */
export const sightingBody = z
  .object({
    lat: ghanaLat,
    lon: ghanaLon,
    kind: z.enum(SIGHTING_KINDS),
    count: z.coerce.number().int().min(1).max(50).default(1),
    release: z.coerce.number().int().positive().max(10_000_000),
    capturedOn: isoDate.nullable().optional(),
    sensor: z
      .string()
      .trim()
      .max(40)
      .regex(/^[\p{L}\p{N} .()/-]*$/u)
      .nullable()
      .optional(),
    changeEventId: z.string().uuid().optional(),
    note: z.string().trim().max(280).optional(),
  })
  .strict();
export type SightingBody = z.infer<typeof sightingBody>;

export const sightingReviewBody = z
  .object({
    status: z.enum(["confirmed", "rejected"]),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

/** Place search: letters (incl. Twi ɛ ɔ), digits, spaces, hyphens and apostrophes. */
export const searchQuery = z
  .object({
    q: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[\p{L}\p{N}\s'’-]+$/u, "only letters, numbers, spaces, hyphens and apostrophes"),
    limit: z.coerce.number().int().min(1).max(20).default(8),
  })
  .strict();

export const nearQuery = z
  .object({
    lon,
    lat,
    radiusKm: z.coerce.number().min(1).max(100).default(25),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    lang: z.enum(LOCALES).optional(),
  })
  .strict();

export const reportBody = z
  .object({
    lat: lat.refine((v) => v >= GHANA_BBOX[1] && v <= GHANA_BBOX[3], "location must be within Ghana"),
    lon: lon.refine((v) => v >= GHANA_BBOX[0] && v <= GHANA_BBOX[2], "location must be within Ghana"),
    accuracyM: z.coerce.number().int().min(0).max(100_000).optional(),
    description: z.string().trim().min(1).max(500),
    category: z.enum(REPORT_CATEGORIES).default("other"),
    changeEventId: uuidParam.optional(),
    /** Where the position came from (the form says; the server also checks the photo). */
    locationSource: z.enum(LOCATION_SOURCES).optional(),
    /** When the report was made, for one that waited offline on the phone. */
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ReportBody = z.infer<typeof reportBody>;

export const loginBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(256),
    code: z.string().trim().regex(/^\d{6}$/).optional(),
  })
  .strict();

export const moderationBody = z
  .object({
    status: z.enum(["approved", "rejected", "needs_info"]),
    note: z.string().trim().max(1000).optional(),
    satelliteVerdict: z.enum(SATELLITE_VERDICTS).optional(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

/** Moving a confirmed case along its public trail. */
export const caseUpdateBody = z
  .object({
    caseStatus: z.enum(["passed_to_authority", "action_seen", "closed"]),
    authority: z.enum(AUTHORITIES).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.caseStatus !== "passed_to_authority" || Boolean(b.authority), { message: "Say which authority the case was passed to", path: ["authority"] });

export const casesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    category: z.enum(REPORT_CATEGORIES).optional(),
    lang: z.enum(LOCALES).optional(),
  })
  .strict();

export const reviewBody = z
  .object({
    status: z.enum(["reviewed", "dismissed", "verified"]),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

/** Allowed upload types, verified again server-side by magic bytes. */
export const PHOTO_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Parse URLSearchParams into a plain object for Zod (repeated keys take the last value). */
export function searchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  sp.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

// ---------------------------------------------------------------------------
// The monthly index, alerts and the credibility tables
// ---------------------------------------------------------------------------

export const monthParam = z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");
export const slugParam = z.string().regex(/^[a-z0-9-]{1,80}$/);

export const indexQuery = z.object({ month: monthParam.optional(), region: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(300).optional() }).strict();
export const nationalQuery = z.object({ month: monthParam.optional() }).strict();

export const subscribeBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    /** District slug; omit for the national digest. */
    district: slugParam.optional(),
    list: z.enum(["public", "journalists", "officials"]).default("public"),
  })
  .strict();
export type SubscribeBody = z.infer<typeof subscribeBody>;

export const tokenQuery = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,80}$/) }).strict();

export const accuracyCheckBody = z
  .object({
    checkedOn: isoDate,
    label: z.string().trim().min(3).max(160),
    kind: z.enum(["optical", "radar", "urgent", "cleared_near_pits", "flood_south", "flood_north", "detection_rate"]),
    region: z.string().trim().max(60).optional(),
    checked: z.coerce.number().int().min(1).max(10_000),
    correct: z.coerce.number().int().min(0).max(10_000),
    note: z.string().trim().max(1000).optional(),
    headline: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.correct <= b.checked, { message: "correct cannot exceed checked", path: ["correct"] });

export const correctionBody = z
  .object({
    publishedOn: isoDate,
    month: monthParam.optional(),
    indexVersion: z.string().regex(/^\d+\.\d+$/),
    whatChanged: z.string().trim().min(5).max(1000),
    why: z.string().trim().min(5).max(1000),
  })
  .strict();

export const sampleVerdictBody = z.object({ verdict: z.enum(["confirmed", "rejected", "unclear"]), note: z.string().trim().max(280).optional() }).strict();

export const intakeBody = z
  .object({
    name: z.string().trim().min(3).max(120),
    river: z.string().trim().min(2).max(40),
    operator: z.string().trim().max(80).default("Ghana Water Ltd"),
    lon: z.coerce.number().min(GHANA_BBOX[0]).max(GHANA_BBOX[2]),
    lat: z.coerce.number().min(GHANA_BBOX[1]).max(GHANA_BBOX[3]),
    source: z.string().trim().max(200).optional(),
  })
  .strict();
