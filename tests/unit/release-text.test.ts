import { describe, expect, it } from "vitest";
import { pressRelease } from "@/lib/server/release/press";
import { sitesGeoJson } from "@/lib/server/release/files";
import type { ReleaseData } from "@/lib/server/release/data";

/** The release says what the index counted: sites first seen (two-date scan) or ground newly confirmed (3.0). */
function data(multisensor: boolean): ReleaseData {
  return {
    month: "2026-09",
    label: "September 2026",
    version: "2.0",
    multisensor,
    national: { month: "2026-09", label: "September 2026", newHa: 120, ciLow: 100, ciHigh: 150, cumHa: 5000, districtsAffected: 12, inReservesHa: 0, newSites: 9, topDistrict: null },
    series: [{ label: "January 2019" }],
    rankings: [],
    top: [],
    sites: [
      { id: "a", firstMonth: "2026-09", districtId: null, districtName: "Amansie Central", areaHa: 4, newSite: true, lon: -1.9, lat: 6.2, reserve: null, onRiver: true, legality: "unknown", eventId: "e1", title: "t", imageDate: "2026-09-20", geom: null },
      { id: "b", firstMonth: "2025-04", districtId: null, districtName: "Amansie Central", areaHa: 1.5, newSite: false, lon: -1.8, lat: 6.1, reserve: null, onRiver: false, legality: "unknown", eventId: null, title: null, imageDate: null, geom: null },
    ],
    featured: [],
    reserves: [],
    rivers: [],
    worstRiver: null,
    topDistrictSeries: [],
  } as unknown as ReleaseData;
}

describe("release text follows the index method", () => {
  it("describes ground newly confirmed, new sites and spread, for the multi-sensor record", () => {
    const p = pressRelease(data(true), "https://ghanawatch.org", "15 October 2026");
    expect(p.markdown).toContain("newly confirmed as mined for gold, at new sites and where existing sites spread");
    expect(p.markdown).toContain("monthly satellite record");
    expect(p.markdown).not.toContain("first seen as likely galamsey");
    expect(p.whatsapp).toContain("confirmed from space");
    const gj = JSON.parse(sitesGeoJson(data(true), "https://ghanawatch.org"));
    expect(gj.name).toContain("newly confirmed");
    expect(gj.features.map((f: { properties: { new_site: boolean } }) => f.properties.new_site)).toEqual([true, false]);
  });
  it("keeps the first-seen wording while the index falls back to the two-date scan", () => {
    const p = pressRelease(data(false), "https://ghanawatch.org", "15 October 2026");
    expect(p.markdown).toContain("first seen as likely galamsey");
    expect(p.markdown).toContain("compares each month with imagery from one to two years earlier");
  });
});
