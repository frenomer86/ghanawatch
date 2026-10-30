import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { getDb } from "@/lib/db/client";
import { changeEvents, contextFeatures } from "@/lib/db/schema";
import { districtContaining } from "@/lib/db/repo/boundaries";
import type { ChangeType } from "@/lib/domain/types";
import { distanceToPlotM, pointInRing, type Plot } from "./plot";

/**
 * Where a plot sits: its district, any forest reserve or protected area it
 * touches or lies near, GhanaWatch detections on it, and the nearest
 * suspected galamsey site.
 */
export interface PlotContext {
  district: string | null;
  region: string | null;
  protectedArea: { name: string; inside: boolean; distanceM: number } | null;
  detectionsOnPlot: Array<{ id: string; type: ChangeType; title: string; imageDate: string }>;
  nearestGalamsey: { id: string; title: string; imageDate: string; distanceM: number } | null;
}

const GALAMSEY_METHOD = "s2-galamsey";

function rings(g: Polygon | MultiPolygon): Position[][] {
  return g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
}

export async function plotContext(plot: Plot): Promise<PlotContext> {
  const db = await getDb();
  const { lon, lat } = plot.center;
  const near = 0.1; // about 11 km
  const [district, reserves, events] = await Promise.all([
    districtContaining(lon, lat).catch(() => null),
    db
      .select({ name: contextFeatures.name, geom: contextFeatures.geom })
      .from(contextFeatures)
      .where(
        and(
          eq(contextFeatures.kind, "protected_area"),
          lte(contextFeatures.bboxMinLon, lon + 0.02),
          gte(contextFeatures.bboxMaxLon, lon - 0.02),
          lte(contextFeatures.bboxMinLat, lat + 0.02),
          gte(contextFeatures.bboxMaxLat, lat - 0.02),
        ),
      ),
    db
      .select({
        id: changeEvents.id,
        type: changeEvents.type,
        title: changeEvents.titleEn,
        imageDate: changeEvents.imageDate,
        lon: changeEvents.centroidLon,
        lat: changeEvents.centroidLat,
        method: changeEvents.methodVersion,
      })
      .from(changeEvents)
      .where(
        and(
          ne(changeEvents.status, "dismissed"),
          inArray(changeEvents.type, ["surface_disturbance", "water_change", "vegetation_loss", "fire", "flood_risk"]),
          gte(changeEvents.centroidLon, lon - near),
          lte(changeEvents.centroidLon, lon + near),
          gte(changeEvents.centroidLat, lat - near),
          lte(changeEvents.centroidLat, lat + near),
        ),
      )
      .limit(5000),
  ]);

  // Closest protected area within 1 km of the plot, preferring one it is inside.
  let protectedArea: PlotContext["protectedArea"] = null;
  for (const r of reserves) {
    const g = r.geom;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    let best = Infinity;
    let inside = false;
    for (const ring of rings(g as Polygon | MultiPolygon)) {
      if (pointInRing(lon, lat, ring as [number, number][])) inside = true;
      // Distance from the reserve boundary to the plot, sampled along the boundary.
      const step = Math.max(1, Math.floor(ring.length / 400));
      for (let i = 0; i < ring.length; i += step) best = Math.min(best, distanceToPlotM(ring[i][0], ring[i][1], plot));
    }
    const distanceM = inside ? 0 : Math.round(best);
    if (distanceM > 1000) continue;
    if (!protectedArea || distanceM < protectedArea.distanceM) protectedArea = { name: r.name ?? "a protected area", inside, distanceM };
  }

  const detectionsOnPlot: PlotContext["detectionsOnPlot"] = [];
  let nearestGalamsey: PlotContext["nearestGalamsey"] = null;
  for (const e of events) {
    if (e.lon == null || e.lat == null) continue;
    if (pointInRing(e.lon, e.lat, plot.ring)) detectionsOnPlot.push({ id: e.id, type: e.type as ChangeType, title: e.title, imageDate: e.imageDate });
    if (e.method?.startsWith(GALAMSEY_METHOD) && e.type !== "fire") {
      // Measured from the plot's edge, so a site on the plot is 0 m away.
      const distanceM = Math.round(distanceToPlotM(e.lon, e.lat, plot));
      if (!nearestGalamsey || distanceM < nearestGalamsey.distanceM) nearestGalamsey = { id: e.id, title: e.title, imageDate: e.imageDate, distanceM };
    }
  }
  return {
    district: district?.name ?? null,
    region: district?.parentName ?? null,
    protectedArea,
    detectionsOnPlot: detectionsOnPlot.slice(0, 20),
    nearestGalamsey,
  };
}
