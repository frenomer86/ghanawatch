import type { LandChange, LandSummary } from "./land";

/**
 * The wording of a land check's findings, used by both the web page and the
 * PDF so the two always say the same thing.
 */
export function dmy(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const ha = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ha`;
const byYear = (rec: Record<string, number>, unit: (v: number) => string) =>
  Object.entries(rec)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([y, v]) => `${y}: ${unit(v)}`)
    .join(", ");

export interface Finding {
  label: string;
  value: string;
  source: string;
}

/** The report's findings in reading order; shared with the web page's wording. */
export function findings(s: LandSummary, c: LandChange | null): Finding[] {
  const out: Finding[] = [];
  if (s.eudr) {
    const e = s.eudr;
    const pct = Math.round(e.forest2020Share * 100);
    out.push({
      label: "Forest at the EU cut-off (31 Dec 2020)",
      value:
        e.finding === "no-forest-2020"
          ? "No forest on the plot at the end of 2020 in the EU's reference map."
          : `Forest covered about ${ha(e.forest2020Ha)} (${pct}%) of the plot at the end of 2020. ${
              e.finding === "forest-loss-seen"
                ? `Tree cover was lost after 2020: ${ha(Math.max(e.lossAfter2020Ha ?? 0, e.alertsAfter2020Ha ?? 0))} in the yearly loss record or the alerts.`
                : "No tree cover loss after 2020 was seen in the yearly loss record or the alerts."
            }`,
      source: `EU Global Forest Cover 2020 (${e.version}, © European Union, CC BY 4.0); tree cover loss and alerts via Global Forest Watch. Evidence for the EU deforestation rule, not a compliance decision`,
    });
  }
  if (c) {
    out.push({
      label: "Mining or clearing since 2020",
      value:
        c.status === "ok"
          ? `Vegetation cleared to bare ground: ${ha(c.clearedHa)}. New open water away from rivers (how mining pits show): ${ha(c.newWaterHa)}. ${Math.round(c.coverage * 100)}% of the plot seen clearly in both periods.`
          : c.status === "cloudy"
            ? `Not enough clear views of the plot to compare (${Math.round(c.coverage * 100)}% seen clearly).`
            : "No Sentinel-2 images were found for one of the two periods.",
      source: `Satellite images, ${dmy(c.before.from)} to ${dmy(c.before.to)} compared with ${dmy(c.after.from)} to ${dmy(c.after.to)}. Contains modified Copernicus Sentinel data`,
    });
  }
  out.push({
    label: "GhanaWatch detections on the plot",
    value: s.detectionsOnPlot.length ? s.detectionsOnPlot.map((d) => `${d.title} (seen ${dmy(d.imageDate)})`).join("; ") : "None.",
    source: "GhanaWatch",
  });
  out.push({
    label: "Nearest suspected galamsey site",
    value: s.nearestGalamsey
      ? s.nearestGalamsey.distanceM === 0
        ? `On the plot: ${s.nearestGalamsey.title} (seen ${dmy(s.nearestGalamsey.imageDate)}).`
        : `${s.nearestGalamsey.distanceM < 1000 ? `${s.nearestGalamsey.distanceM} m` : `${(s.nearestGalamsey.distanceM / 1000).toFixed(1)} km`} from the plot: ${s.nearestGalamsey.title} (seen ${dmy(s.nearestGalamsey.imageDate)}).`
      : "None found within about 11 km.",
    source: "GhanaWatch",
  });
  if (s.forestLoss) {
    out.push({
      label: "Tree cover loss",
      value:
        s.forestLoss.totalHa > 0
          ? `${s.forestLoss.since2020Ha > 0 ? `Since 2020: ${ha(s.forestLoss.since2020Ha)}.` : "None since 2020."} Since 2001: ${ha(s.forestLoss.totalHa)} (${byYear(s.forestLoss.byYear, ha)}).`
          : "None recorded since 2001.",
      source: "Hansen/UMD/Google/USGS/NASA, via Global Forest Watch (CC BY 4.0)",
    });
  }
  if (s.alerts) {
    out.push({
      label: "Deforestation alerts",
      value: s.alerts.since2020Ha > 0 ? `Since 2020: ${ha(s.alerts.since2020Ha)}, of which ${ha(s.alerts.highConfidenceHa)} high confidence. Latest alert ${dmy(s.alerts.latest)}.` : "None since 2020.",
      source: "Global Forest Watch (CC BY 4.0)",
    });
  }
  if (s.fires) {
    out.push({
      label: "Fires",
      value: s.fires.total > 0 ? `${s.fires.total} fire detection${s.fires.total === 1 ? "" : "s"} (${byYear(s.fires.byYear, (v) => String(v))}); latest ${dmy(s.fires.lastDate)}.` : "None detected.",
      source: `NASA FIRMS, ${dmy(s.fires.recordFrom)} to ${dmy(s.fires.recordTo)}`,
    });
  }
  out.push({
    label: "Forest reserve or protected area",
    value: s.protectedArea ? (s.protectedArea.inside ? `Inside ${s.protectedArea.name}.` : `${s.protectedArea.distanceM} m from ${s.protectedArea.name}.`) : "None within 1 km.",
    source: "OpenStreetMap protected areas (may be incomplete)",
  });
  out.push({
    label: "Flood zone",
    value: "Not assessed in this report. Flood-prone land and river forecasts are on the GhanaWatch Floods page.",
    source: "",
  });
  return out;
}

