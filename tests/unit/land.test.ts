import { describe, expect, it } from "vitest";
import { circlePlot, distanceToPlotM, lonLatToTile, pointInRing, tileToLonLat } from "@/lib/server/land/plot";
import { decodeAlert, decodeLossYear } from "@/lib/server/land/forest";
import { winAnsi } from "@/lib/server/land/pdf";
import { findings } from "@/lib/domain/land-findings";
import type { LandSummary } from "@/lib/domain/land";
import { dedupeScenes, type Scene } from "@/pipeline/s2/stac";
import { parseCountryCsv } from "@/pipeline/adapters/firms-archive";
import { landQuery } from "@/lib/domain/validation";

describe("plot geometry", () => {
  const plot = circlePlot(-0.5856, 6.3101, 250);

  it("builds a closed circle with the right area and extent", () => {
    expect(plot.ring[0]).toEqual(plot.ring[plot.ring.length - 1]);
    expect(plot.areaHa).toBeCloseTo(19.63, 1);
    expect(pointInRing(-0.5856, 6.3101, plot.ring)).toBe(true);
    expect(pointInRing(-0.58, 6.3101, plot.ring)).toBe(false);
  });

  it("measures distance to the plot edge", () => {
    expect(distanceToPlotM(-0.5856, 6.3101, plot)).toBe(0);
    // 0.0045° of latitude is about 498 m from the centre, so about 248 m from the edge.
    expect(distanceToPlotM(-0.5856, 6.3146, plot)).toBeGreaterThan(230);
    expect(distanceToPlotM(-0.5856, 6.3146, plot)).toBeLessThan(265);
  });

  it("converts between tiles and coordinates both ways", () => {
    const t = lonLatToTile(-0.5856, 6.3101, 14);
    const back = tileToLonLat(t.x, t.y, 14);
    expect(back.lon).toBeCloseTo(-0.5856, 6);
    expect(back.lat).toBeCloseTo(6.3101, 6);
  });
});

describe("Global Forest Watch tile decoding", () => {
  it("reads the year of tree cover loss from the blue channel", () => {
    expect(decodeLossYear(255, 23)).toBe(2023);
    expect(decodeLossYear(0, 23)).toBeNull();
    expect(decodeLossYear(255, 0)).toBeNull();
  });

  it("reads alert dates and confidence", () => {
    // Day 4219 after 2014-12-31 is 2026-07-20; blue 210 is high confidence.
    expect(decodeAlert(16, 139, 210, 8)).toEqual({ date: "2026-07-20", confidence: 1 });
    expect(decodeAlert(12, 180, 110, 8)?.confidence).toBe(0);
    expect(decodeAlert(0, 0, 100, 0)).toBeNull();
  });
});

describe("land report wording", () => {
  const summary: LandSummary = {
    plot: { lat: 6.3101, lon: -0.5856, radiusM: 250, areaHa: 19.63 },
    place: { district: "Atiwa West", region: "Eastern Region" },
    protectedArea: { name: "Atewa Range Forest Reserve", inside: false, distanceM: 449 },
    detectionsOnPlot: [],
    nearestGalamsey: { id: "x", title: "Likely mining pits", imageDate: "2026-10-02", distanceM: 330 },
    forestLoss: { byYear: { "2019": 0.35, "2021": 1.2 }, totalHa: 1.55, since2020Ha: 1.2, version: "v1.13", complete: true },
    alerts: { byYear: {}, since2020Ha: 0, highConfidenceHa: 0, latest: null, version: "v20261016", complete: true },
    eudr: { forest2020Ha: 5.2, forest2020Share: 0.26, lossAfter2020Ha: 1.2, alertsAfter2020Ha: 0, finding: "forest-loss-seen", version: "JRC GFC2020 V4" },
    fires: { byYear: { "2024": 2 }, total: 2, firstDate: "2024-01-03", lastDate: "2024-03-27", recordFrom: "2020-01-01", recordTo: "2025-12-31" },
    closeUp: null,
    mosaicYears: { first: 2020, latest: 2025 },
    generatedAt: "2026-10-17T00:00:00.000Z",
    notes: [],
  };

  it("states every finding with its source, and says what is not assessed", () => {
    const f = findings(summary, null);
    const byLabel = Object.fromEntries(f.map((x) => [x.label, x]));
    expect(byLabel["Tree cover loss"].value).toContain("Since 2020: 1.20 ha");
    expect(findings({ ...summary, forestLoss: { ...summary.forestLoss!, since2020Ha: 0 } }, null).find((x) => x.label === "Tree cover loss")!.value).toMatch(/^None since 2020. Since 2001/);
    expect(byLabel["Deforestation alerts"].value).toBe("None since 2020.");
    expect(byLabel["Fires"].value).toContain("2 fire detections");
    expect(byLabel["Forest reserve or protected area"].value).toBe("449 m from Atewa Range Forest Reserve.");
    expect(byLabel["Nearest suspected galamsey site"].value).toContain("330 m from the plot");
    expect(findings({ ...summary, nearestGalamsey: { ...summary.nearestGalamsey!, distanceM: 0 } }, null).find((x) => x.label === "Nearest suspected galamsey site")!.value).toMatch(/^On the plot/);
    expect(byLabel["Flood zone"].value).toContain("Not assessed");
    const eudr = byLabel["Forest at the EU cut-off (31 Dec 2020)"];
    expect(eudr.value).toContain("26%");
    expect(eudr.value).toContain("lost after 2020: 1.20 ha");
    expect(eudr.source).toContain("not a compliance decision");
    expect(findings({ ...summary, eudr: { ...summary.eudr!, forest2020Share: 0, finding: "no-forest-2020" } }, null)[0].value).toMatch(/^No forest on the plot/);
    expect(f.every((x) => x.label === "Flood zone" || x.source.length > 0)).toBe(true);
  });

  it("keeps PDF text inside the standard font's characters", () => {
    expect(winAnsi("Kɔfɔ ≥ 2 → done – ok")).toBe("Kofo >= 2 -> done – ok");
  });
});

describe("data hygiene", () => {
  const scene = (id: string, cloud: number) => ({ id, cloud }) as unknown as Scene;

  it("keeps one Sentinel-2 scene per tile and date, the latest processing run", () => {
    const out = dedupeScenes([scene("S2B_30NYN_20200127_0_L2A", 1), scene("S2B_30NYN_20200127_1_L2A", 1), scene("S2A_30NYM_20200127_0_L2A", 3)]);
    expect(out.map((s) => s.id).sort()).toEqual(["S2A_30NYM_20200127_0_L2A", "S2B_30NYN_20200127_1_L2A"]);
  });

  it("keeps only presumed vegetation fires with nominal or high confidence from the FIRMS archive", () => {
    const csv = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type",
      "10.91262,-0.62255,316.25,0.42,0.37,2023-01-01,0143,N,VIIRS,n,2,291.75,1.17,N,0",
      "10.88295,-0.63538,304.53,0.42,0.37,2023-01-01,143,N,VIIRS,l,2,291.34,0.65,N,0",
      "9.97068,-2.01233,304.47,0.39,0.36,2023-01-01,0143,N,VIIRS,h,2,286.64,1.11,N,2",
      "48.85,2.35,304.47,0.39,0.36,2023-01-01,0143,N,VIIRS,h,2,286.64,1.11,N,0",
    ].join("\n");
    const rows = parseCountryCsv(csv, "firms-archive");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lat: 10.91262, lon: -0.62255, acqDate: "2023-01-01", acqTime: "0143", confidence: "n" });
  });

  it("limits plots to a pin in Ghana and a radius up to 1 km", () => {
    expect(landQuery.parse({ lat: "6.31", lon: "-0.58" }).r).toBe(100);
    expect(landQuery.safeParse({ lat: "6.31", lon: "-0.58", r: "5000" }).success).toBe(false);
  });
});
