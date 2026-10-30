import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { constants as zc, gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { rows as toRows, type Db } from "@/lib/db/client";
import type { BBox } from "@/lib/domain/types";
import { monthOf, previousMonth } from "@/lib/domain/index";
import { DATA_DIR } from "./cell";
import { detector } from "./mode";
import { monthIndex } from "./tracker";

/**
 * Cell by cell handover from the two-date scan (2.x) to the multi-sensor tracker (3.0).
 *
 * A cell's land galamsey (pits, cleared ground with pits, radar ponds) stays with 2.x until the tracker has
 * brought that cell's monthly record up to the present; from then on it belongs to 3.0, and the 2.x scan
 * keeps the two jobs 3.0 does not do there: muddy rivers, and cleared land that is not part of a mining site
 * (farms, roads, building, logging), which feeds the district and forest-reserve cards. So nothing goes dark
 * while the national backfill runs, and nothing is counted twice once it has.
 */

/** Month index of the last month a cell's tracker processed, or -1. Reads only the start of the state file. */
export function stateLastMonth(cellId: string): number {
  const p = join(DATA_DIR, "state", `${cellId}.gwts`);
  if (!existsSync(p)) return -1;
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(4096);
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  let head = buf.subarray(0, n);
  try {
    if (head[0] === 0x1f && head[1] === 0x8b) head = gunzipSync(head, { finishFlush: zc.Z_SYNC_FLUSH });
  } catch {
    return -1;
  }
  if (head.length < 24 || head.readUInt32LE(0) !== 0x47575453) return -1;
  return head.readInt32LE(16);
}

/** Months a handed-over cell may fall behind (a month boundary, a slow run) before 2.x takes it back. */
export const HANDOVER_SLACK = 2;

/** True when this cell's land galamsey belongs to the multi-sensor tracker. */
export function handedOver(cellId: string, now: Date): boolean {
  if (detector() === "legacy") return false;
  return stateLastMonth(cellId) >= monthIndex(previousMonth(monthOf(now))) - HANDOVER_SLACK;
}

/** Bounding boxes of the live 3.0 mining sites in a cell. */
export async function liveSiteBoxes(db: Db, cellId: string): Promise<BBox[]> {
  const rows = toRows<{ a: number; b: number; c: number; d: number }>(
    await db.execute(sql`select bbox_min_lon as a, bbox_min_lat as b, bbox_max_lon as c, bbox_max_lat as d from change_events
      where method_version = 's2-galamsey-3.0' and status <> 'dismissed' and properties->>'cell' = ${cellId}::text`),
  );
  return rows.map((r) => [Number(r.a), Number(r.b), Number(r.c), Number(r.d)] as BBox);
}

/** Share of box `a` that lies inside any of `boxes` (the largest single overlap). */
export function coveredShare(a: BBox, boxes: BBox[]): number {
  const area = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  if (!area) return boxes.some((b) => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3]) ? 1 : 0;
  let best = 0;
  for (const b of boxes) {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w > 0 && h > 0) best = Math.max(best, (w * h) / area);
  }
  return best;
}

/** Cleared ground is part of a mining site when at least half of its outline's box lies in the site's box. */
export const UNDER_MINING_SHARE = 0.5;
