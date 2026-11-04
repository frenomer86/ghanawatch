/**
 * GhanaWatch database schema (Drizzle ORM, Postgres dialect).
 *
 * Runs unchanged on PGlite (local dev, embedded) and Postgres 15+ (production).
 * Geometry is stored as GeoJSON in `geom` (jsonb) together with materialised
 * bounding-box and centroid columns, which is what every spatial filter in the
 * API uses. Production may add a PostGIS `geometry(Geometry,4326)` column with
 * a GIST index in a later migration without changing the application code.
 *
 * Conventions: UUID v7 primary keys generated in application code
 * (see src/lib/server/ids.ts), timestamps in UTC, explicit ON DELETE.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Geometry } from "geojson";
import {
  AUTHORITIES,
  CASE_STATUSES,
  CHANGE_TYPES,
  CONFIDENCES,
  EVENT_STATUSES,
  LOCALES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  SATELLITE_VERDICTS,
  SEVERITIES,
  SIGHTING_KINDS,
  SIGHTING_STATUSES,
  SOURCE_CATEGORIES,
} from "@/lib/domain/types";

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(", ")})`);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Materialised bbox + centroid, shared by every geometry-bearing table. */
const spatial = {
  geom: jsonb("geom").$type<Geometry>(),
  bboxMinLon: numeric("bbox_min_lon", { precision: 9, scale: 6, mode: "number" }),
  bboxMinLat: numeric("bbox_min_lat", { precision: 9, scale: 6, mode: "number" }),
  bboxMaxLon: numeric("bbox_max_lon", { precision: 9, scale: 6, mode: "number" }),
  bboxMaxLat: numeric("bbox_max_lat", { precision: 9, scale: 6, mode: "number" }),
  centroidLon: numeric("centroid_lon", { precision: 9, scale: 6, mode: "number" }),
  centroidLat: numeric("centroid_lat", { precision: 9, scale: 6, mode: "number" }),
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    url: text("url").notNull(),
    docUrl: text("doc_url"),
    category: text("category").notNull(),
    description: text("description").notNull().default(""),
    licence: text("licence").notNull(),
    attributionText: text("attribution_text").notNull(),
    cadence: text("cadence"),
    resolutionM: integer("resolution_m"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("data_sources_slug_uq").on(t.slug),
    check("data_sources_category_ck", inList("category", SOURCE_CATEGORIES)),
  ],
);

export const adminBoundaries = pgTable(
  "admin_boundaries",
  {
    id: uuid("id").primaryKey(),
    level: text("level").notNull(), // region | district
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): any => adminBoundaries.id, {
      onDelete: "restrict",
    }),
    areaKm2: numeric("area_km2", { precision: 12, scale: 3, mode: "number" }),
    population: integer("population"),
    ...spatial,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("admin_boundaries_code_uq").on(t.code),
    index("admin_boundaries_level_name_idx").on(t.level, t.name),
    index("admin_boundaries_bbox_idx").on(t.bboxMinLon, t.bboxMaxLon, t.bboxMinLat, t.bboxMaxLat),
    check("admin_boundaries_level_ck", sql`level in ('region', 'district')`),
  ],
);

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running"), // running | ok | partial | failed
    watermark: timestamp("watermark", { withTimezone: true }),
    fetched: integer("fetched").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    error: text("error"),
    /** Adapter summary, e.g. river levels checked by the flood adapter. */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("pipeline_runs_source_started_idx").on(t.sourceId, t.startedAt),
    check("pipeline_runs_status_ck", sql`status in ('running', 'ok', 'partial', 'failed')`),
  ],
);

// ---------------------------------------------------------------------------
// Users and sessions (optional accounts; MVP = admin and moderators only)
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email"),
    phone: text("phone"),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("citizen"), // citizen | moderator | admin
    locale: text("locale").notNull().default("en"),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** Two-step sign-in: authenticator secret, encrypted with a key derived from APP_SECRET. */
    totpSecret: text("totp_secret"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** Last accepted 30-second step, so a code is never accepted twice. */
    totpLastStep: integer("totp_last_step"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_phone_uq").on(t.phone),
    check("users_role_ck", sql`role in ('citizen', 'moderator', 'admin')`),
    check("users_locale_ck", inList("locale", LOCALES)),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the opaque token handed to the browser; the raw token is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

export const changeEvents = pgTable(
  "change_events",
  {
    id: uuid("id").primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceEventId: text("source_event_id").notNull(),
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    imageDate: date("image_date").notNull(),
    imageDateEnd: date("image_date_end"),
    /**
     * The first satellite date on which GhanaWatch saw this site. Set once on insert and never overwritten by
     * a rescan (image_date is), so "first seen this month" means what it says. The monthly index counts a site
     * in the month of this date.
     */
    firstImageDate: date("first_image_date"),
    confidence: text("confidence").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 3, mode: "number" }),
    severity: text("severity").notNull(),
    areaHa: numeric("area_ha", { precision: 12, scale: 3, mode: "number" }),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    ...spatial,
    titleEn: text("title_en").notNull(),
    titleTw: text("title_tw"),
    descriptionEn: text("description_en").notNull().default(""),
    descriptionTw: text("description_tw"),
    status: text("status").notNull().default("new"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    methodVersion: text("method_version"),
    /** Provider-specific extras. Never rendered as HTML; read through allow-listed keys only. */
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("change_events_source_event_uq").on(t.sourceId, t.sourceEventId),
    index("change_events_detected_idx").on(t.detectedAt),
    index("change_events_type_detected_idx").on(t.type, t.detectedAt),
    index("change_events_district_detected_idx").on(t.districtId, t.detectedAt),
    index("change_events_severity_detected_idx").on(t.severity, t.detectedAt),
    index("change_events_bbox_idx").on(t.bboxMinLon, t.bboxMaxLon, t.bboxMinLat, t.bboxMaxLat),
    index("change_events_status_new_idx").on(t.status).where(sql`status = 'new'`),
    index("change_events_first_seen_idx").on(t.firstImageDate),
    check("change_events_type_ck", inList("type", CHANGE_TYPES)),
    check("change_events_confidence_ck", inList("confidence", CONFIDENCES)),
    check("change_events_severity_ck", inList("severity", SEVERITIES)),
    check("change_events_status_ck", inList("status", EVENT_STATUSES)),
    check("change_events_area_ck", sql`area_ha is null or area_ha >= 0`),
    check("change_events_score_ck", sql`confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)`),
    check("change_events_dates_ck", sql`image_date <= detected_at::date`),
  ],
);

export const imageReferences = pgTable(
  "image_references",
  {
    id: uuid("id").primaryKey(),
    changeEventId: uuid("change_event_id")
      .notNull()
      .references(() => changeEvents.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // latest | before | after
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    productId: text("product_id"),
    sensor: text("sensor"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    cloudCoverPct: numeric("cloud_cover_pct", { precision: 5, scale: 2, mode: "number" }),
    thumbnailUrl: text("thumbnail_url"),
    tileUrlTemplate: text("tile_url_template"),
    bboxMinLon: numeric("bbox_min_lon", { precision: 9, scale: 6, mode: "number" }),
    bboxMinLat: numeric("bbox_min_lat", { precision: 9, scale: 6, mode: "number" }),
    bboxMaxLon: numeric("bbox_max_lon", { precision: 9, scale: 6, mode: "number" }),
    bboxMaxLat: numeric("bbox_max_lat", { precision: 9, scale: 6, mode: "number" }),
    licence: text("licence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("image_references_event_role_idx").on(t.changeEventId, t.role),
    check("image_references_role_ck", sql`role in ('latest', 'before', 'after')`),
    check("image_references_cloud_ck", sql`cloud_cover_pct is null or (cloud_cover_pct >= 0 and cloud_cover_pct <= 100)`),
  ],
);

export const hotspots = pgTable(
  "hotspots",
  {
    id: uuid("id").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    eventCount: integer("event_count").notNull(),
    areaHaTotal: numeric("area_ha_total", { precision: 14, scale: 3, mode: "number" }),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    isNew: boolean("is_new").notNull().default(false),
    labelEn: text("label_en").notNull(),
    labelTw: text("label_tw"),
    ...spatial,
    ...timestamps,
  },
  (t) => [
    index("hotspots_window_end_idx").on(t.windowEnd),
    index("hotspots_bbox_idx").on(t.bboxMinLon, t.bboxMaxLon, t.bboxMinLat, t.bboxMaxLat),
    index("hotspots_district_idx").on(t.districtId),
    check("hotspots_type_ck", inList("type", CHANGE_TYPES)),
    check("hotspots_severity_ck", inList("severity", SEVERITIES)),
    check("hotspots_count_ck", sql`event_count > 0`),
    check("hotspots_window_ck", sql`window_start < window_end`),
  ],
);

export const hotspotEvents = pgTable(
  "hotspot_events",
  {
    hotspotId: uuid("hotspot_id")
      .notNull()
      .references(() => hotspots.id, { onDelete: "cascade" }),
    changeEventId: uuid("change_event_id")
      .notNull()
      .references(() => changeEvents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.hotspotId, t.changeEventId] })],
);

// ---------------------------------------------------------------------------
// Watchlists, alerts, community reports
// ---------------------------------------------------------------------------

export const areasOfInterest = pgTable(
  "areas_of_interest",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // district | point_radius | polygon
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    radiusM: integer("radius_m"),
    channels: jsonb("channels")
      .$type<{ inApp: boolean; sms: boolean; whatsapp: boolean }>()
      .notNull()
      .default({ inApp: true, sms: false, whatsapp: false }),
    minSeverity: text("min_severity").notNull().default("watch"),
    isActive: boolean("is_active").notNull().default(true),
    ...spatial,
    ...timestamps,
  },
  (t) => [
    index("aoi_user_idx").on(t.userId),
    index("aoi_device_idx").on(t.deviceId),
    index("aoi_bbox_idx").on(t.bboxMinLon, t.bboxMaxLon, t.bboxMinLat, t.bboxMaxLat),
    check("aoi_kind_ck", sql`kind in ('district', 'point_radius', 'polygon')`),
    check("aoi_target_ck", sql`(district_id is not null) <> (geom is not null)`),
    check("aoi_owner_ck", sql`user_id is not null or device_id is not null`),
    check("aoi_min_sev_ck", inList("min_severity", SEVERITIES)),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey(),
    changeEventId: uuid("change_event_id")
      .notNull()
      .references(() => changeEvents.id, { onDelete: "cascade" }),
    areaOfInterestId: uuid("area_of_interest_id").references(() => areasOfInterest.id, {
      onDelete: "cascade",
    }),
    severity: text("severity").notNull(),
    titleEn: text("title_en").notNull(),
    titleTw: text("title_tw"),
    bodyEn: text("body_en").notNull(),
    bodyTw: text("body_tw"),
    channel: text("channel").notNull().default("in_app"),
    status: text("status").notNull().default("queued"),
    dedupeKey: text("dedupe_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("alerts_dedupe_uq").on(t.dedupeKey),
    index("alerts_aoi_created_idx").on(t.areaOfInterestId, t.createdAt),
    index("alerts_public_feed_idx").on(t.createdAt).where(sql`area_of_interest_id is null`),
    index("alerts_queued_idx").on(t.status).where(sql`status = 'queued'`),
    check("alerts_severity_ck", inList("severity", SEVERITIES)),
    check("alerts_channel_ck", sql`channel in ('in_app', 'sms', 'whatsapp', 'push')`),
    check("alerts_status_ck", sql`status in ('queued', 'sent', 'failed', 'read')`),
  ],
);

/**
 * Power-cut tracker: anonymous "lights off" and "lights back" reports. Locations are rounded to about
 * 300 m before they are stored; the caller's network address is kept only as a salted hash, to stop one
 * person reporting the same thing over and over. No account, no name, no photo.
 */
export const powerReports = pgTable(
  "power_reports",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(), // off | on
    lat: numeric("lat", { precision: 8, scale: 4, mode: "number" }).notNull(),
    lon: numeric("lon", { precision: 8, scale: 4, mode: "number" }).notNull(),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
    ipHash: text("ip_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("power_reports_time_idx").on(t.happenedAt),
    index("power_reports_district_idx").on(t.districtId, t.happenedAt),
    check("power_reports_kind_ck", sql`kind in ('off', 'on')`),
    check("power_reports_in_ghana_ck", sql`lon between -3.4 and 1.3 and lat between 4.6 and 11.3`),
  ],
);

export const communityReports = pgTable(
  "community_reports",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    changeEventId: uuid("change_event_id").references(() => changeEvents.id, { onDelete: "set null" }),
    lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    lon: numeric("lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    accuracyM: integer("accuracy_m"),
    description: text("description").notNull(),
    category: text("category").notNull().default("other"),
    photoKey: text("photo_key"),
    photoSha256: text("photo_sha256"),
    status: text("status").notNull().default("pending"),
    moderatorId: uuid("moderator_id").references(() => users.id, { onDelete: "set null" }),
    moderationNote: text("moderation_note"),
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    submittedIpHash: text("submitted_ip_hash"),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    /** Automatic comparison with GhanaWatch's satellite detections and imagery, filled in after the report arrives. */
    satelliteCheck: jsonb("satellite_check").$type<Record<string, unknown>>(),
    satelliteVerdict: text("satellite_verdict").notNull().default("under_review"),
    caseStatus: text("case_status").notNull().default("reported"),
    authority: text("authority"),
    /** Where the reported position came from: the photo's own GPS, the phone's location, or a pin on the map. */
    locationSource: text("location_source"),
    /** When the reporter made the report (it can wait offline on the phone); null means when it arrived. */
    observedAt: timestamp("observed_at", { withTimezone: true }),
    /** GPS position, accuracy and time read from the original photo before its metadata was removed. Never public. */
    photoMeta: jsonb("photo_meta").$type<Record<string, unknown>>(),
    /** The automatic verification (src/lib/domain/auto-review.ts): decision, reasons, evidence, next check. */
    autoReview: jsonb("auto_review").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    index("community_reports_status_created_idx").on(t.status, t.createdAt),
    check("community_reports_location_source_ck", sql`location_source is null or location_source in ('photo', 'device', 'pin')`),
    index("community_reports_latlon_idx").on(t.lat, t.lon),
    check("community_reports_status_ck", inList("status", REPORT_STATUSES)),
    check("community_reports_category_ck", inList("category", REPORT_CATEGORIES)),
    check("community_reports_verdict_ck", inList("satellite_verdict", SATELLITE_VERDICTS)),
    check("community_reports_case_ck", inList("case_status", CASE_STATUSES)),
    check("community_reports_authority_ck", sql`authority is null or ${inList("authority", AUTHORITIES)}`),
    check("community_reports_desc_ck", sql`char_length(description) between 1 and 500`),
    check("community_reports_in_ghana_ck", sql`lon between -3.4 and 1.3 and lat between 4.6 and 11.3`),
  ],
);

/** Each step of a report's public case trail, with who moved it and a short public note. */
export const reportCaseEvents = pgTable(
  "report_case_events",
  {
    id: uuid("id").primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => communityReports.id, { onDelete: "cascade" }),
    caseStatus: text("case_status").notNull(),
    authority: text("authority"),
    note: text("note"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("report_case_events_report_idx").on(t.reportId, t.createdAt),
    check("report_case_events_case_ck", inList("case_status", CASE_STATUSES)),
    check("report_case_events_note_ck", sql`note is null or char_length(note) <= 1000`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId), index("audit_log_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Context layers and national scan bookkeeping
// ---------------------------------------------------------------------------

export const CONTEXT_KINDS = [
  "school",
  "cemetery",
  "health",
  "worship",
  "settlement",
  "residential",
  "farm",
  "protected_area",
  "mine",
  "waterway",
  "wetland",
] as const;

/**
 * Civilian and environmental context from OpenStreetMap, used to say where a
 * detection is (inside a residential area, 120 m from a school, in a forest
 * reserve) and to raise its risk level. Refreshed from Overpass by `npm run seed`.
 */
export const contextFeatures = pgTable(
  "context_features",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name"),
    osmRef: text("osm_ref").notNull(),
    centroidLon: numeric("centroid_lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    centroidLat: numeric("centroid_lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    bboxMinLon: numeric("bbox_min_lon", { precision: 9, scale: 6, mode: "number" }),
    bboxMinLat: numeric("bbox_min_lat", { precision: 9, scale: 6, mode: "number" }),
    bboxMaxLon: numeric("bbox_max_lon", { precision: 9, scale: 6, mode: "number" }),
    bboxMaxLat: numeric("bbox_max_lat", { precision: 9, scale: 6, mode: "number" }),
    /** Outline for protected areas, mapped mines and wetlands; the line for waterways. */
    geom: jsonb("geom").$type<Geometry>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("context_features_osm_uq").on(t.osmRef, t.kind),
    index("context_features_kind_idx").on(t.kind),
    index("context_features_centroid_idx").on(t.centroidLon, t.centroidLat),
    check("context_features_kind_ck", inList("kind", CONTEXT_KINDS)),
  ],
);

/**
 * The national Sentinel-2 scan: Ghana divided into 0.2° cells, each scanned in
 * rotation. Priority cells (known mining belts) are revisited more often and
 * analysed at 20 m; others at 40 m.
 */
export const analysisCells = pgTable(
  "analysis_cells",
  {
    id: text("id").primaryKey(),
    minLon: numeric("min_lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    minLat: numeric("min_lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    maxLon: numeric("max_lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    maxLat: numeric("max_lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    priority: integer("priority").notNull().default(1),
    resM: integer("res_m").notNull().default(40),
    regionName: text("region_name"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** A targeted re-check was asked for (an outside signal named a place in this cell); scanned first. */
    recheckRequestedAt: timestamp("recheck_requested_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    coverageAfter: integer("coverage_after"),
    sites: integer("sites").notNull().default(0),
    turbid: integer("turbid").notNull().default(0),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("analysis_cells_due_idx").on(t.priority, t.lastRunAt)],
);

/**
 * Machinery that people have spotted on a dated high-resolution close-up in
 * Ground view (excavators, trucks, washing plants, dredgers). Each sighting
 * records which imagery release and capture date it was seen on, because the
 * close-ups are often years old. Public sightings wait for a moderator;
 * moderators' own sightings are confirmed at once. Tracing features on Esri
 * World Imagery to create vector data is permitted by its terms.
 */
export const machinerySightings = pgTable(
  "machinery_sightings",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(1),
    lon: numeric("lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    imagerySource: text("imagery_source").notNull().default("esri-world-imagery"),
    imageryRelease: integer("imagery_release"),
    imageryCapturedOn: date("imagery_captured_on"),
    imagerySensor: text("imagery_sensor"),
    changeEventId: uuid("change_event_id").references(() => changeEvents.id, { onDelete: "set null" }),
    note: text("note"),
    status: text("status").notNull().default("pending"),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedIpHash: text("submitted_ip_hash"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("machinery_sightings_status_created_idx").on(t.status, t.createdAt),
    index("machinery_sightings_lonlat_idx").on(t.lon, t.lat),
    check("machinery_sightings_kind_ck", inList("kind", SIGHTING_KINDS)),
    check("machinery_sightings_status_ck", inList("status", SIGHTING_STATUSES)),
    check("machinery_sightings_count_ck", sql`count between 1 and 50`),
    check("machinery_sightings_note_ck", sql`note is null or char_length(note) <= 280`),
    check("machinery_sightings_in_ghana_ck", sql`lon between -3.9 and 1.8 and lat between 4.1 and 11.8`),
  ],
);

/**
 * Every NASA FIRMS VIIRS (Suomi NPP) fire detection in Ghana since 2020, one
 * row per detection: the yearly country archive files plus the live feed from
 * then on. Used to say whether a plot has burned. Low-confidence detections
 * and persistent non-vegetation heat sources are left out.
 */
export const firePoints = pgTable(
  "fire_points",
  {
    lon: numeric("lon", { precision: 8, scale: 5, mode: "number" }).notNull(),
    lat: numeric("lat", { precision: 7, scale: 5, mode: "number" }).notNull(),
    acqDate: date("acq_date").notNull(),
    acqTime: text("acq_time").notNull(),
    confidence: text("confidence").notNull(),
    frp: real("frp"),
    source: text("source").notNull(),
    /** District the fire fell in (null outside every district outline). */
    districtId: uuid("district_id"),
  },
  (t) => [
    primaryKey({ columns: [t.lat, t.lon, t.acqDate, t.acqTime] }),
    index("fire_points_lonlat_idx").on(t.lon, t.lat),
    index("fire_points_date_idx").on(t.acqDate),
    index("fire_points_district_date_idx").on(t.districtId, t.acqDate),
  ],
);

/**
 * Tree cover lost in each district per year (Hansen/UMD via Global Forest
 * Watch's public tiles, canopy of at least 30%), for the district scorecards.
 * Refreshed when Global Forest Watch publishes a new year.
 */
export const districtForestLoss = pgTable(
  "district_forest_loss",
  {
    districtId: uuid("district_id")
      .notNull()
      .references(() => adminBoundaries.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    lossHa: real("loss_ha").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.districtId, t.year] })],
);

/**
 * Rain forecast for the next three days at each district's centre (free public forecast, refreshed
 * several times a day). One row per district and forecast day; the newest run replaces the old.
 */
export const districtRain = pgTable(
  "district_rain",
  {
    districtId: uuid("district_id")
      .notNull()
      .references(() => adminBoundaries.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    rainMm: real("rain_mm").notNull(),
    rainHours: real("rain_hours"),
    maxHourlyMm: real("max_hourly_mm"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.districtId, t.day] })],
);

/**
 * Rivers watched by radar for dredgers and floating mining platforms (Pra,
 * Ankobra, Offin, Birim, Tano), and the bridges, dams and weirs on them that
 * reflect radar the same way and must be ignored. From OpenStreetMap.
 */
export const riverLines = pgTable(
  "river_lines",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(), // river | structure
    name: text("name"),
    osmRef: text("osm_ref").notNull(),
    geom: jsonb("geom").$type<Geometry>().notNull(),
    bboxMinLon: numeric("bbox_min_lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    bboxMinLat: numeric("bbox_min_lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    bboxMaxLon: numeric("bbox_max_lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    bboxMaxLat: numeric("bbox_max_lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("river_lines_osm_uq").on(t.osmRef, t.kind), check("river_lines_kind_ck", sql`kind in ('river', 'structure')`)],
);

/** Sentinel-1 scenes already examined, so each radar pass is analysed once. */
export const radarScenes = pgTable("radar_scenes", {
  id: text("id").primaryKey(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
  orbit: text("orbit"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  riverTargets: integer("river_targets").notNull().default(0),
  windows: integer("windows").notNull().default(0),
  note: text("note"),
});

/** When each scan cell was last checked by radar for new ponds, and what was found. */
export const radarCells = pgTable("radar_cells", {
  cellId: text("cell_id").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  ponds: integer("ponds").notNull().default(0),
  recentScenes: integer("recent_scenes").notNull().default(0),
  baselineScenes: integer("baseline_scenes").notNull().default(0),
  coverage: integer("coverage"),
  note: text("note"),
});

/**
 * Strong radar reflections found on open river water, one row per pass. A
 * reflection seen again within 120 m on another day becomes a dredger tag for
 * a moderator to check (machinery_sightings); a single one stays here.
 */
export const radarTargets = pgTable(
  "radar_targets",
  {
    id: uuid("id").primaryKey(),
    sceneId: text("scene_id").notNull(),
    acqDate: date("acq_date").notNull(),
    lon: numeric("lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    vvDb: real("vv_db").notNull(),
    vhDb: real("vh_db"),
    river: text("river"),
    sightingId: uuid("sighting_id").references(() => machinerySightings.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("radar_targets_lonlat_idx").on(t.lon, t.lat), index("radar_targets_date_idx").on(t.acqDate), uniqueIndex("radar_targets_scene_pt_uq").on(t.sceneId, t.lon, t.lat)],
);

// ---------------------------------------------------------------------------
// Relations (for drizzle relational queries)
// ---------------------------------------------------------------------------

export const dataSourcesRelations = relations(dataSources, ({ many }) => ({
  events: many(changeEvents),
  runs: many(pipelineRuns),
}));

export const changeEventsRelations = relations(changeEvents, ({ one, many }) => ({
  source: one(dataSources, { fields: [changeEvents.sourceId], references: [dataSources.id] }),
  district: one(adminBoundaries, { fields: [changeEvents.districtId], references: [adminBoundaries.id] }),
  run: one(pipelineRuns, { fields: [changeEvents.runId], references: [pipelineRuns.id] }),
  images: many(imageReferences),
}));

export const imageReferencesRelations = relations(imageReferences, ({ one }) => ({
  event: one(changeEvents, { fields: [imageReferences.changeEventId], references: [changeEvents.id] }),
  source: one(dataSources, { fields: [imageReferences.sourceId], references: [dataSources.id] }),
}));

export const adminBoundariesRelations = relations(adminBoundaries, ({ one, many }) => ({
  parent: one(adminBoundaries, {
    fields: [adminBoundaries.parentId],
    references: [adminBoundaries.id],
    relationName: "parent",
  }),
  children: many(adminBoundaries, { relationName: "parent" }),
  events: many(changeEvents),
}));

export const hotspotsRelations = relations(hotspots, ({ one, many }) => ({
  district: one(adminBoundaries, { fields: [hotspots.districtId], references: [adminBoundaries.id] }),
  members: many(hotspotEvents),
}));

export const hotspotEventsRelations = relations(hotspotEvents, ({ one }) => ({
  hotspot: one(hotspots, { fields: [hotspotEvents.hotspotId], references: [hotspots.id] }),
  event: one(changeEvents, { fields: [hotspotEvents.changeEventId], references: [changeEvents.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  areas: many(areasOfInterest),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const areasOfInterestRelations = relations(areasOfInterest, ({ one, many }) => ({
  user: one(users, { fields: [areasOfInterest.userId], references: [users.id] }),
  district: one(adminBoundaries, { fields: [areasOfInterest.districtId], references: [adminBoundaries.id] }),
  alerts: many(alerts),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  event: one(changeEvents, { fields: [alerts.changeEventId], references: [changeEvents.id] }),
  area: one(areasOfInterest, { fields: [alerts.areaOfInterestId], references: [areasOfInterest.id] }),
}));

export const communityReportsRelations = relations(communityReports, ({ one }) => ({
  user: one(users, { fields: [communityReports.userId], references: [users.id] }),
  event: one(changeEvents, { fields: [communityReports.changeEventId], references: [changeEvents.id] }),
}));

export type DataSource = typeof dataSources.$inferSelect;
export type ChangeEvent = typeof changeEvents.$inferSelect;
export type NewChangeEvent = typeof changeEvents.$inferInsert;
export type Hotspot = typeof hotspots.$inferSelect;
export type AdminBoundary = typeof adminBoundaries.$inferSelect;
export type ImageReferenceRow = typeof imageReferences.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type User = typeof users.$inferSelect;
export type CommunityReport = typeof communityReports.$inferSelect;

/** Scan cells already read for Global Forest Watch integrated alerts, and when. */
/**
 * Signals from public news and disaster feeds (internal only, never shown on public pages). A story naming a
 * place with galamsey, flooding, fire and the like queues a targeted satellite re-check there and can raise
 * the confidence of detections already found nearby. A signal never creates a detection by itself.
 */
export const newsSignals = pgTable(
  "news_signals",
  {
    id: uuid("id").primaryKey(),
    source: text("source").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    eventType: text("event_type").notNull(),
    placeName: text("place_name"),
    placeKind: text("place_kind"),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    lon: numeric("lon", { precision: 9, scale: 6, mode: "number" }),
    lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }),
    confidence: real("confidence").notNull(),
    /** What it set off: cells queued for re-check, detections corroborated, and later what the re-check found. */
    triggered: jsonb("triggered").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("news_signals_url_type_uq").on(t.url, t.eventType), index("news_signals_published_idx").on(t.publishedAt)],
);

export const alertCells = pgTable("alert_cells", {
  cellId: text("cell_id").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  alerts: integer("alerts").notNull().default(0),
  tiles: integer("tiles").notNull().default(0),
});

// ---------------------------------------------------------------------------
// The monthly index: frozen figures, history, uncertainty, releases, alerts
// ---------------------------------------------------------------------------

/**
 * Detections from the historical scan (the national Sentinel-2 method run with a past "now", one row per
 * site per scan month). Kept apart from the live tables so the map and feed never show history as news.
 * first_month is set when the index is closed: the first month any site within about 200 m was seen.
 */
export const historyEvents = pgTable(
  "history_events",
  {
    id: uuid("id").primaryKey(),
    scanMonth: text("scan_month").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    type: text("type").notNull(),
    imageDate: date("image_date").notNull(),
    confidence: text("confidence").notNull(),
    severity: text("severity").notNull(),
    areaHa: numeric("area_ha", { precision: 12, scale: 3, mode: "number" }),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    ...spatial,
    methodVersion: text("method_version").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    firstMonth: text("first_month"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("history_events_month_source_uq").on(t.scanMonth, t.sourceEventId),
    index("history_events_district_month_idx").on(t.districtId, t.scanMonth),
    index("history_events_first_month_idx").on(t.firstMonth),
    check("history_events_month_ck", sql`scan_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'`),
  ],
);

/** Which cells and months the historical scan has finished, so a stopped run resumes where it left off. */
export const historyProgress = pgTable(
  "history_progress",
  {
    cellId: text("cell_id").notNull(),
    scanMonth: text("scan_month").notNull(),
    status: text("status").notNull(), // ok | no-imagery | failed
    sites: integer("sites").notNull().default(0),
    coverageAfter: integer("coverage_after"),
    note: text("note"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cellId, t.scanMonth] }), index("history_progress_month_idx").on(t.scanMonth)],
);

/**
 * The Galamsey Index, frozen per district and month when the month is closed. index = hectares newly mined
 * per 100 km² of the district; rank 1 = worst. A closed month is never recomputed under the same
 * index_version; a method change creates a new version and a corrections entry.
 */
export const districtMonths = pgTable(
  "district_months",
  {
    districtId: uuid("district_id")
      .notNull()
      .references(() => adminBoundaries.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    indexVersion: text("index_version").notNull().default("1.0"),
    newHa: real("new_ha").notNull().default(0),
    cumHa: real("cum_ha").notNull().default(0),
    index: real("index").notNull().default(0),
    rank: integer("rank"),
    newSites: integer("new_sites").notNull().default(0),
    activeSites: integer("active_sites").notNull().default(0),
    pctForest: real("pct_forest"),
    pctRiver: real("pct_river"),
    pctUnlicensed: real("pct_unlicensed"),
    ciLow: real("ci_low"),
    ciHigh: real("ci_high"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.districtId, t.month, t.indexVersion] }), index("district_months_month_idx").on(t.month, t.indexVersion)],
);

export const nationalMonths = pgTable(
  "national_months",
  {
    month: text("month").notNull(),
    indexVersion: text("index_version").notNull().default("1.0"),
    newHa: real("new_ha").notNull().default(0),
    cumHa: real("cum_ha").notNull().default(0),
    ciLow: real("ci_low"),
    ciHigh: real("ci_high"),
    newSites: integer("new_sites").notNull().default(0),
    districtsAffected: integer("districts_affected").notNull().default(0),
    topDistrictId: uuid("top_district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    inReservesHa: real("in_reserves_ha").notNull().default(0),
    riverKmDiscoloured: real("river_km_discoloured"),
    /** Months of the series that were open (still being scanned) when this one was closed. */
    partial: boolean("partial").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.month, t.indexVersion] })],
);

/**
 * Random-sample checks of the map against before/after imagery. The accuracy page reads these, and the
 * index's uncertainty uses the latest precision and detection rate. Numbers are typed in from the review
 * sheets by a moderator, never computed from the detections themselves.
 */
export const accuracyChecks = pgTable(
  "accuracy_checks",
  {
    id: uuid("id").primaryKey(),
    checkedOn: date("checked_on", { mode: "string" }).notNull(),
    label: text("label").notNull(),
    /** optical | radar | urgent | cleared_near_pits | flood_south | flood_north | detection_rate */
    kind: text("kind").notNull(),
    region: text("region"),
    checked: integer("checked").notNull(),
    correct: integer("correct").notNull(),
    note: text("note"),
    /** True for the whole-of-Ghana checks the headline figure is read from. */
    headline: boolean("headline").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accuracy_checks_date_idx").on(t.checkedOn), check("accuracy_checks_counts_ck", sql`checked > 0 and correct >= 0 and correct <= checked`)],
);

/** The 30 new sites drawn at random when a month is closed, checked by a moderator before the release goes out. */
export const confirmationSamples = pgTable(
  "confirmation_samples",
  {
    id: uuid("id").primaryKey(),
    month: text("month").notNull(),
    changeEventId: uuid("change_event_id")
      .notNull()
      .references(() => changeEvents.id, { onDelete: "cascade" }),
    /** confirmed | rejected | unclear; null while unchecked. */
    verdict: text("verdict"),
    note: text("note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("confirmation_samples_month_event_uq").on(t.month, t.changeEventId), index("confirmation_samples_month_idx").on(t.month)],
);

/** Ghana Water Ltd intakes on the watched rivers, so every district and river page can say how close mining is to drinking water. */
export const waterIntakes = pgTable(
  "water_intakes",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    river: text("river").notNull(),
    operator: text("operator").notNull().default("Ghana Water Ltd"),
    lon: numeric("lon", { precision: 9, scale: 6, mode: "number" }).notNull(),
    lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }).notNull(),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "set null" }),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("water_intakes_name_uq").on(t.name)],
);

/** Every change to a published number, dated, with the reason. Shown on the methodology page. */
export const corrections = pgTable(
  "corrections",
  {
    id: uuid("id").primaryKey(),
    publishedOn: date("published_on", { mode: "string" }).notNull(),
    month: text("month"),
    indexVersion: text("index_version").notNull(),
    whatChanged: text("what_changed").notNull(),
    why: text("why").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("corrections_date_idx").on(t.publishedOn)],
);

/** One row per published monthly release: what was written where, and the DOI once deposited. */
export const releases = pgTable(
  "releases",
  {
    month: text("month").notNull(),
    indexVersion: text("index_version").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    dryRun: boolean("dry_run").notNull().default(false),
    doi: text("doi"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    headline: text("headline").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.month, t.indexVersion] })],
);

/**
 * Email subscriptions to the weekly alert digest: national, or one district. A subscription is confirmed by
 * the link in the first email when a mail service is set up, and at once when it is not.
 */
export const alertSubscriptions = pgTable(
  "alert_subscriptions",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    districtId: uuid("district_id").references(() => adminBoundaries.id, { onDelete: "cascade" }),
    /** public | journalists | officials */
    list: text("list").notNull().default("public"),
    token: text("token").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("alert_subscriptions_email_idx").on(sql`lower(${t.email})`),
    uniqueIndex("alert_subscriptions_token_uq").on(t.token),
    check("alert_subscriptions_list_ck", sql`list in ('public', 'journalists', 'officials')`),
  ],
);

/** Each weekly digest that went out, so the feed can list past weeks and a week is never sent twice. */
export const alertDigests = pgTable(
  "alert_digests",
  {
    id: uuid("id").primaryKey(),
    weekEnding: date("week_ending", { mode: "string" }).notNull(),
    newSites: integer("new_sites").notNull().default(0),
    newHa: real("new_ha").notNull().default(0),
    districts: integer("districts").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    text: text("text").notNull(),
    emailsSent: integer("emails_sent").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alert_digests_week_uq").on(t.weekEnding)],
);
