import type { Geometry } from "geojson";
import type { ChangeType, Confidence, Severity } from "@/lib/domain/types";

/**
 * Every provider adapter normalises its feed into NormalisedEvent records.
 * The runner validates geometry, assigns districts, scores severity, and
 * upserts on (source, sourceEventId) so re-runs are idempotent.
 */
export interface NormalisedEvent {
  sourceSlug: string;
  sourceEventId: string;
  type: ChangeType;
  detectedAt: Date;
  imageDate: string; // YYYY-MM-DD
  imageDateEnd?: string | null;
  /** When the change began, if the detector knows it (YYYY-MM-DD); defaults to imageDate. Never moves later. */
  firstImageDate?: string | null;
  confidence: Confidence;
  confidenceScore?: number | null;
  /** Optional override; otherwise computed by the runner from type, area and confidence. */
  severity?: Severity;
  areaHa?: number | null;
  geom: Geometry;
  titleEn: string;
  titleTw?: string | null;
  descriptionEn: string;
  descriptionTw?: string | null;
  methodVersion: string;
  properties?: Record<string, unknown>;
  images?: Array<{
    role: "latest" | "before" | "after";
    sourceSlug: string;
    productId?: string | null;
    sensor?: string | null;
    acquiredAt: Date;
    cloudCoverPct?: number | null;
    thumbnailUrl?: string | null;
    /** For Sentinel-2: the true-colour COG used to render this image. */
    tileUrlTemplate?: string | null;
    licence?: string | null;
  }>;
}

export interface AdapterContext {
  /** Save detections immediately (long-running adapters), instead of only when run() returns. */
  emit?: (events: NormalisedEvent[]) => Promise<void>;
  /** Database handle, for adapters that keep their own bookkeeping (e.g. the national scan grid). */
  db?: import("@/lib/db/client").Db;
  /** Fetch events newer than this instant; undefined on the first run. */
  since?: Date;
  now: Date;
  log: (msg: string) => void;
  /** Fetch with timeout, retries and a user agent; never shells out. */
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>;
  fetchText: (url: string, init?: RequestInit) => Promise<string>;
  env: Record<string, never>;
}

export interface AdapterResult {
  events: NormalisedEvent[];
  /** Highest provider timestamp seen; stored as the watermark for the next run. */
  watermark?: Date;
  notes?: string[];
  /** Adapter-specific summary stored with the run (e.g. river levels checked). */
  extra?: Record<string, unknown>;
}

export interface Adapter {
  slug: string;
  /** Skip scheduled runs if the last successful run is more recent than this. */
  minIntervalHours?: number;
  run: (ctx: AdapterContext) => Promise<AdapterResult>;
}

/** A source that is not connected: not a failure and not data. */
export class NotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConnectedError";
  }
}
