import { sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import { rows as toRows, type Db } from "@/lib/db/client";
import { pointInPolygon } from "@/lib/geo";

/**
 * Detections inside a licensed mine. A pit or clearing whose centre lies inside a large-scale mine or quarry
 * mapped in OpenStreetMap (named or with an operator) is legal mining: it stays on the map in grey, labelled
 * with the mine's name, is never raised to Urgent, and is not counted as galamsey. OpenStreetMap maps only some
 * of Ghana's licensed mines, so a site outside the mapped ones is not proof of illegality.
 */
export async function markLicensed(db: Db): Promise<{ marked: number; cleared: number }> {
  const mines = toRows<{ name: string | null; geom: Polygon; a: number; b: number; c: number; d: number }>(
    await db.execute(sql`
      select name, geom, bbox_min_lon::float a, bbox_min_lat::float b, bbox_max_lon::float c, bbox_max_lat::float d
      from context_features where kind = 'mine' and geom is not null`),
  );
  const rows = toRows<{ id: string; lon: number; lat: number; had: string | null }>(
    await db.execute(sql`
      select id::text, centroid_lon::float lon, centroid_lat::float lat, properties->>'licensedMine' had
      from change_events
      where status <> 'dismissed' and type in ('surface_disturbance', 'water_change')
        and (method_version like 's2-galamsey-%' or method_version like 's1-water-%')`),
  );
  const marks: Array<{ id: string; name: string }> = [];
  const clear: string[] = [];
  for (const r of rows) {
    const m = mines.find((m) => r.lon >= m.a && r.lon <= m.c && r.lat >= m.b && r.lat <= m.d && pointInPolygon([r.lon, r.lat], m.geom));
    if (m) {
      if (r.had !== (m.name ?? "a licensed mine")) marks.push({ id: r.id, name: m.name ?? "a licensed mine" });
    } else if (r.had != null) clear.push(r.id);
  }
  for (let i = 0; i < marks.length; i += 300) {
    await db.execute(sql`
      update change_events e set
        severity = 'normal',
        properties = (e.properties - 'severityBefore' - 'urgentClusterHa') || jsonb_build_object('licensedMine', v.name)
      from (select x->>'id' as id, x->>'name' as name from jsonb_array_elements(${JSON.stringify(marks.slice(i, i + 300))}::text::jsonb) x) v
      where e.id::text = v.id`);
  }
  for (let i = 0; i < clear.length; i += 500) {
    await db.execute(sql`
      update change_events set properties = properties - 'licensedMine'
      where id::text in (select jsonb_array_elements_text(${JSON.stringify(clear.slice(i, i + 500))}::text::jsonb))`);
  }
  return { marked: marks.length, cleared: clear.length };
}
