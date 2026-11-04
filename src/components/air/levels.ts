import type { AqiLevel, HeatLevel } from "@/lib/domain/air-heat";

/** Colours of the air-quality and heat levels (the usual AQI colours, as light tints). */
export const AQI_CLS: Record<AqiLevel, string> = {
  good: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  moderate: "bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200",
  sensitive: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  unhealthy: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  veryUnhealthy: "bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-200",
  hazardous: "bg-rose-200 text-rose-950 dark:bg-rose-900 dark:text-rose-100",
};
export const HEAT_CLS: Record<HeatLevel, string> = {
  none: "bg-muted text-muted-foreground",
  caution: "bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200",
  extremeCaution: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  danger: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  extremeDanger: "bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-200",
};
