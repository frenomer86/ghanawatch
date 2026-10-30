import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Which galamsey detector is live.
 *
 *  multisensor (default): the monthly multi-sensor time-series detector (adapters/timeseries.ts, method
 *    s2-galamsey-3.0) takes over land galamsey cell by cell, as each cell's monthly record reaches the
 *    present (ts/handover.ts). The two-date Sentinel-2 scan keeps muddy rivers and cleared land outside
 *    mining sites everywhere, and its pits until the cell is handed over; the radar adapter keeps its river
 *    watch for dredgers, and its ponds through cloud until the cell is handed over.
 *  legacy: the two-date Sentinel-2 scan (s2-galamsey-2.x) and radar ponds (s1-water-1.0) everywhere, as
 *    before. Kept for comparison and as a fallback; set GW_DETECTOR=legacy.
 *
 * Without the model files (models/gw_mining_unet.onnx and .json) the legacy detector runs, whatever the
 * setting, so a machine that has the code but not yet the model never stops detecting on land.
 */
export type Detector = "multisensor" | "legacy";

export function detector(): Detector {
  if (process.env.GW_DETECTOR === "legacy") return "legacy";
  const dir = process.env.GW_MODEL_DIR ?? join(process.cwd(), "models");
  return existsSync(join(dir, "gw_mining_unet.onnx")) && existsSync(join(dir, "gw_mining_unet.json")) ? "multisensor" : "legacy";
}
