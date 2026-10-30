/**
 * Which galamsey detector is live.
 *
 *  multisensor (default): the monthly multi-sensor time-series detector (adapters/timeseries.ts, method
 *    s2-galamsey-3.0). The older Sentinel-2 two-date scan keeps running for one job only, muddy rivers in
 *    the mining belt, and the radar adapter keeps its river watch for dredgers; their land detections
 *    (cleared ground, new pits, radar ponds) are now part of the new detector.
 *  legacy: the two-date Sentinel-2 scan (s2-galamsey-2.x) and radar ponds (s1-water-1.0) as before.
 *    Kept for comparison and as a fallback; set GW_DETECTOR=legacy.
 */
export type Detector = "multisensor" | "legacy";
export const detector = (): Detector => (process.env.GW_DETECTOR === "legacy" ? "legacy" : "multisensor");
