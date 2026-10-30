import type { ChangeType } from "./types";

/**
 * "Check this land" report shapes, shared by the API, the page and the PDF.
 * Every figure carries its source and period so it can be read and cited.
 */
export interface LandSummary {
  plot: { lat: number; lon: number; radiusM: number; areaHa: number };
  place: { district: string | null; region: string | null };
  protectedArea: { name: string; inside: boolean; distanceM: number } | null;
  detectionsOnPlot: Array<{ id: string; type: ChangeType; title: string; imageDate: string }>;
  nearestGalamsey: { id: string; title: string; imageDate: string; distanceM: number } | null;
  forestLoss: { byYear: Record<string, number>; totalHa: number; since2020Ha: number; version: string | null; complete: boolean } | null;
  alerts: { byYear: Record<string, number>; since2020Ha: number; highConfidenceHa: number; latest: string | null; version: string | null; complete: boolean } | null;
  /**
   * Evidence for the EU deforestation rule (EUDR), whose cut-off is 31 December 2020: forest on the plot on
   * that date in the EU's reference map, and tree loss and alerts after it. Evidence only, never a verdict.
   */
  eudr: {
    forest2020Ha: number;
    forest2020Share: number;
    lossAfter2020Ha: number | null;
    alertsAfter2020Ha: number | null;
    finding: "no-forest-2020" | "forest-no-loss-seen" | "forest-loss-seen";
    version: string;
  } | null;
  fires: { byYear: Record<string, number>; total: number; firstDate: string | null; lastDate: string | null; recordFrom: string | null; recordTo: string | null } | null;
  closeUp: { capturedOn: string | null; sensor: string | null; provider: string | null; resolutionM: number | null; release: number } | null;
  mosaicYears: { first: number; latest: number } | null;
  generatedAt: string;
  notes: string[];
}

export interface LandChange {
  status: "ok" | "cloudy" | "no-imagery";
  clearedHa: number;
  newWaterHa: number;
  coverage: number;
  before: { from: string; to: string; scenes: string[] };
  after: { from: string; to: string; scenes: string[] };
}

export const LAND_RADII = [50, 100, 250, 500, 1000] as const;
