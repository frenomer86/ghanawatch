import type { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { auditLog, waterIntakes } from "@/lib/db/schema";
import { intakeBody } from "@/lib/domain/validation";
import { requireRole } from "@/lib/server/auth";
import { assertSameOrigin, clientIpHash, handle, json, parseJson } from "@/lib/server/http";
import { stableId, uuidv7 } from "@/lib/server/ids";

/** POST /api/v1/admin/intakes — adds or updates a drinking-water intake (GWCL / Water Resources Commission records). */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireRole(req, "moderator", "admin");
  const body = await parseJson(req, intakeBody);
  const db = await getDb();
  const id = stableId("intake", body.name);
  await db
    .insert(waterIntakes)
    .values({ id, name: body.name, river: body.river, operator: body.operator, lon: body.lon, lat: body.lat, source: body.source ?? null })
    .onConflictDoUpdate({ target: waterIntakes.name, set: { river: sql`excluded.river`, operator: sql`excluded.operator`, lon: sql`excluded.lon`, lat: sql`excluded.lat`, source: sql`excluded.source` } });
  await db.execute(sql`
    update water_intakes w set district_id = d.id from admin_boundaries d
    where w.id = ${id} and d.level = 'district' and w.lon between d.bbox_min_lon and d.bbox_max_lon and w.lat between d.bbox_min_lat and d.bbox_max_lat`);
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "intake_saved", entity: "water_intake", entityId: id, diff: body, ipHash: clientIpHash(req) });
  return json({ id }, { status: 201 });
});
