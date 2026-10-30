import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { auditLog, machinerySightings } from "@/lib/db/schema";
import type { SightingKind, SightingStatus } from "@/lib/domain/types";
import type { SightingBody } from "@/lib/domain/validation";
import { haversineKm } from "@/lib/geo";
import { uuidv7 } from "@/lib/server/ids";
import type { Sighting } from "@/lib/explore/imagery";

/** Machinery tags made on dated close-ups in Ground view. */

export type { Sighting };

type Row = typeof machinerySightings.$inferSelect;

function toSighting(r: Row): Sighting {
  return {
    id: r.id,
    kind: r.kind as SightingKind,
    source: r.imagerySource,
    count: r.count,
    lon: r.lon,
    lat: r.lat,
    release: r.imageryRelease,
    capturedOn: r.imageryCapturedOn,
    sensor: r.imagerySensor,
    status: r.status as SightingStatus,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function createSighting(
  body: SightingBody,
  who: { userId: string | null; trusted: boolean; ipHash: string },
): Promise<Sighting> {
  const db = await getDb();
  const [row] = await db
    .insert(machinerySightings)
    .values({
      id: uuidv7(),
      kind: body.kind,
      count: body.count,
      lon: Number(body.lon.toFixed(6)),
      lat: Number(body.lat.toFixed(6)),
      imagerySource: "esri-world-imagery",
      imageryRelease: body.release,
      imageryCapturedOn: body.capturedOn ?? null,
      imagerySensor: body.sensor ?? null,
      changeEventId: body.changeEventId ?? null,
      note: body.note || null,
      // Moderators vouch for their own tags; everyone else's wait for review.
      status: who.trusted ? "confirmed" : "pending",
      submittedBy: who.userId,
      submittedIpHash: who.ipHash,
      reviewedBy: who.trusted ? who.userId : null,
      reviewedAt: who.trusted ? new Date() : null,
    })
    .returning();
  return toSighting(row);
}

/** Confirmed sightings within `radiusM` of a point, nearest first. */
export async function confirmedSightingsNear(point: { lon: number; lat: number }, radiusM = 3000): Promise<Sighting[]> {
  const db = await getDb();
  const d = radiusM / 100_000; // degrees, generous at Ghana's latitudes
  const rows = await db
    .select()
    .from(machinerySightings)
    .where(
      and(
        eq(machinerySightings.status, "confirmed"),
        gte(machinerySightings.lon, point.lon - d),
        lte(machinerySightings.lon, point.lon + d),
        gte(machinerySightings.lat, point.lat - d),
        lte(machinerySightings.lat, point.lat + d),
      ),
    )
    .limit(500);
  return rows
    .map((r) => ({ ...toSighting(r), distanceM: Math.round(haversineKm(point, r) * 1000) }))
    .filter((s) => s.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, 100);
}

export async function pendingSightings(limit = 50): Promise<Sighting[]> {
  const db = await getDb();
  const rows = await db.select().from(machinerySightings).where(eq(machinerySightings.status, "pending")).orderBy(desc(machinerySightings.createdAt)).limit(limit);
  return rows.map(toSighting);
}

/** Moderator decision, guarded by the row's updatedAt so two moderators cannot both decide it. */
export async function reviewSighting(
  id: string,
  decision: { status: "confirmed" | "rejected"; expectedUpdatedAt: string },
  reviewer: { id: string; ipHash: string },
): Promise<Sighting | null> {
  const db = await getDb();
  const [row] = await db
    .update(machinerySightings)
    .set({ status: decision.status, reviewedBy: reviewer.id, reviewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(machinerySightings.id, id), eq(machinerySightings.updatedAt, new Date(decision.expectedUpdatedAt))))
    .returning();
  if (!row) return null;
  await db.insert(auditLog).values({
    id: uuidv7(),
    actorId: reviewer.id,
    action: `sighting_${decision.status}`,
    entity: "machinery_sighting",
    entityId: id,
    diff: null,
    ipHash: reviewer.ipHash,
  });
  return toSighting(row);
}
