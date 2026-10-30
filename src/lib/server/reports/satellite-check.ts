import { and, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { changeEvents } from "@/lib/db/schema";
import type { ChangeType, ReportCategory } from "@/lib/domain/types";
import type { SatelliteCheck } from "@/lib/domain/cases";
import { haversineKm } from "@/lib/geo";
import { highResCaptures } from "@/lib/server/explore/wayback";

/**
 * Automatic comparison of a citizen report with what GhanaWatch's satellite
 * analysis has found at the same place: detections of a matching kind within
 * 750 m in the past year, and the newest high-resolution close-up of the spot.
 * The result is a suggestion for the moderator, who sets the public verdict.
 */
export type { SatelliteCheck };

export const CHECK_RADIUS_M = 750;

/** Which detection types count as satellite evidence for each kind of report. */
export const MATCHING_TYPES: Record<ReportCategory, ChangeType[]> = {
  galamsey: ["surface_disturbance", "water_change", "vegetation_loss"],
  dumping: ["surface_disturbance", "vegetation_loss"],
  fire: ["fire"],
  flooding: ["flood_risk", "water_change"],
  other: ["surface_disturbance", "water_change", "vegetation_loss", "fire", "flood_risk"],
};

export function suggestVerdict(detectionCount: number): SatelliteCheck["suggestion"] {
  return detectionCount > 0 ? "confirmed_by_satellite" : "not_visible_yet";
}

export async function satelliteCheck(lon: number, lat: number, category: ReportCategory, now = new Date()): Promise<SatelliteCheck> {
  const db = await getDb();
  const d = 0.008; // about 890 m
  const since = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      title: changeEvents.titleEn,
      severity: changeEvents.severity,
      imageDate: changeEvents.imageDate,
      lon: changeEvents.centroidLon,
      lat: changeEvents.centroidLat,
    })
    .from(changeEvents)
    .where(
      and(
        inArray(changeEvents.type, MATCHING_TYPES[category]),
        ne(changeEvents.status, "dismissed"),
        gte(changeEvents.imageDate, since),
        gte(changeEvents.centroidLon, lon - d),
        lte(changeEvents.centroidLon, lon + d),
        gte(changeEvents.centroidLat, lat - d),
        lte(changeEvents.centroidLat, lat + d),
      ),
    )
    .limit(200);
  const detections = rows
    .filter((r) => r.lon != null && r.lat != null)
    .map((r) => ({
      id: r.id,
      type: r.type as ChangeType,
      title: r.title,
      severity: r.severity,
      imageDate: r.imageDate,
      distanceM: Math.round(haversineKm({ lon, lat }, { lon: r.lon!, lat: r.lat! }) * 1000),
    }))
    .filter((r) => r.distanceM <= CHECK_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, 5);

  let closeUp: SatelliteCheck["closeUp"] = null;
  try {
    const newest = (await highResCaptures(lon, lat))[0];
    if (newest) closeUp = { capturedOn: newest.capturedOn, sensor: newest.sensor, resolutionM: newest.resolutionM, release: newest.release };
  } catch {
    // The close-up date is context, not evidence; leave it out if Esri does not answer.
  }

  return { checkedAt: now.toISOString(), radiusM: CHECK_RADIUS_M, suggestion: suggestVerdict(detections.length), detections, closeUp };
}
