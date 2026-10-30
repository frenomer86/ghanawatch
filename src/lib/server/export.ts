import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { ChangeEventSummary } from "@/lib/domain/types";
import { env } from "./env";

/**
 * CSV and GeoJSON serialisation for researcher downloads. Every row carries
 * provenance (source, image date, confidence, method) and the export itself
 * carries licence and citation so a file found later is still attributable.
 */

export const EXPORT_COLUMNS = [
  "id",
  "type",
  "severity",
  "confidence",
  "image_date",
  "image_date_end",
  "detected_at",
  "area_ha",
  "district",
  "region",
  "centroid_lon",
  "centroid_lat",
  "source",
  "status",
  "record_url",
] as const;

export function csvEscape(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Neutralise spreadsheet formula injection; plain numbers (incl. negative coordinates) pass through.
  const numeric = typeof v === "number" || /^-?\d+(\.\d+)?$/.test(s);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function eventToCsvRow(e: ChangeEventSummary): string {
  const origin = env().PUBLIC_ORIGIN;
  return [
    e.id,
    e.type,
    e.severity,
    e.confidence,
    e.imageDate,
    e.imageDateEnd ?? "",
    e.detectedAt,
    e.areaHa ?? "",
    e.districtName ?? "",
    e.regionName ?? "",
    e.centroid.lon.toFixed(5),
    e.centroid.lat.toFixed(5),
    e.sourceSlug,
    e.status,
    `${origin}/event/${e.id}`,
  ]
    .map(csvEscape)
    .join(",");
}

export function csvHeader(): string {
  return EXPORT_COLUMNS.join(",");
}

export function exportMetadata(generatedAt = new Date()) {
  const origin = env().PUBLIC_ORIGIN;
  return {
    generatedAt: generatedAt.toISOString(),
    publisher: "GhanaWatch",
    licence: "CC BY 4.0 for derived records; upstream provider licences apply to source products",
    citation: `GhanaWatch (${generatedAt.getUTCFullYear()}). Environmental change detections for Ghana [data set]. ${origin}/data`,
    documentation: `${origin}/data/methods`,
    sources: `${origin}/data/sources`,
  };
}

export function eventToFeature(e: ChangeEventSummary, geometry?: Geometry): Feature<Geometry, Record<string, unknown>> {
  return {
    type: "Feature",
    id: e.id,
    geometry: geometry ?? { type: "Point", coordinates: [e.centroid.lon, e.centroid.lat] },
    properties: {
      id: e.id,
      type: e.type,
      severity: e.severity,
      confidence: e.confidence,
      image_date: e.imageDate,
      image_date_end: e.imageDateEnd ?? null,
      detected_at: e.detectedAt,
      area_ha: e.areaHa,
      district: e.districtName,
      region: e.regionName,
      source: e.sourceSlug,
      source_name: e.sourceName,
      status: e.status,
      title: e.title,
    },
  };
}

export function featureCollectionWithMeta(features: Feature<Geometry, Record<string, unknown>>[]): FeatureCollection & {
  metadata: ReturnType<typeof exportMetadata>;
} {
  return { type: "FeatureCollection", features, metadata: exportMetadata() };
}

/** Stream an async iterator of CSV lines as a text/csv response. */
export function csvStream(lines: AsyncIterable<string>, filename: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`${csvHeader()}\n`));
        for await (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
