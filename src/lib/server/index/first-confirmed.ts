import { sql } from "drizzle-orm";

/**
 * For each site of the multi-sensor record (s2-galamsey-3.0), the month its record first confirmed it as mined:
 * the earliest of its history rows (`m`, YYYY-MM), keyed by the site key that is also its live detection's
 * source_event_id. This, not the onset month (when mining began, usually months before the evidence was
 * enough), is when GhanaWatch first saw the site, and it does not move when a cell's detections are published
 * for the first time.
 */
export const FIRST_CONFIRMED = sql`(select source_event_id, min(scan_month) as m from history_events
  where method_version like 's2-galamsey-3.%' and properties->>'cohort' = 'true' group by source_event_id)`;
