import { and, desc, sql } from "drizzle-orm";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { getDb } from "../client";
import { changeEvents } from "../schema";
import type { BBox, ChangeType, Severity } from "@/lib/domain/types";
import { buildFilters } from "./events";

/** Polygons for the zoomed-in map. Only geometry and the few properties the map styles need. */
export async function listFootprints(opts: {
  bbox: BBox;
  since: Date;
  type?: ChangeType;
  severity?: Severity;
  possible?: "0" | "1";
  limit: number;
}): Promise<FeatureCollection> {
  const db = await getDb();
  const rows = await db
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      severity: changeEvents.severity,
      licensed: sql<boolean>`${changeEvents.properties} ? 'licensedMine'`,
      geom: changeEvents.geom,
      imageDate: changeEvents.imageDate,
      detectedAt: changeEvents.detectedAt,
      areaHa: changeEvents.areaHa,
    })
    .from(changeEvents)
    .where(and(...buildFilters({ bbox: opts.bbox, since: opts.since, type: opts.type, severity: opts.severity, possible: opts.possible })))
    .orderBy(desc(changeEvents.detectedAt))
    .limit(opts.limit);
  const features: Feature<Geometry, Record<string, unknown>>[] = rows
    .filter((r) => r.geom)
    .map((r) => ({
      type: "Feature",
      id: r.id,
      geometry: r.geom as Geometry,
      properties: { id: r.id, type: r.type, severity: r.licensed ? "licensed" : r.severity, imageDate: r.imageDate, detectedAt: r.detectedAt.toISOString(), areaHa: r.areaHa },
    }));
  return { type: "FeatureCollection", features };
}
