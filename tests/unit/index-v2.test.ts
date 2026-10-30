import { describe, expect, it } from "vitest";
import { buildIndex, INDEX_VERSION } from "@/lib/domain/index";
import { assignSites, newAreaIn, type Sighting } from "@/lib/domain/sites";

const base = { districtId: "d1", likely: true, inReserve: false, reserve: null, inRiverBuffer: false, legality: "unknown" as const, inMine: false };
const row = (id: string, month: string, lon: number, ha: number, siteKey?: string): Sighting => ({ id, month, lon, lat: 6, areaHa: ha, ...base, addsArea: true, siteKey: siteKey ?? null });

describe("Galamsey Index 2.0: area added per month", () => {
  it("is version 2.0", () => expect(INDEX_VERSION).toBe("2.0"));

  it("counts a spreading site in every month it spread, not only when first seen", () => {
    const sites = assignSites([row("a", "2021-03", -2, 2, "ts-a"), row("b", "2021-07", -2.01, 3, "ts-a"), row("c", "2022-01", -2.05, 1.5, "ts-a")]);
    expect(sites).toHaveLength(1); // same detector site, even though the rows' centres are kilometres apart
    expect(sites[0].firstMonth).toBe("2021-03");
    expect(newAreaIn(sites[0], "2021-07")).toBe(3);
    const idx = buildIndex(sites, [{ id: "d1", name: "Tarkwa", region: null, areaKm2: 100 }], ["2021-03", "2021-07", "2022-01"]);
    expect(idx.national.map((n) => n.newHa)).toEqual([2, 3, 1.5]);
    expect(idx.national.at(-1)!.cumHa).toBe(6.5);
    expect(idx.national.map((n) => n.newSites)).toEqual([1, 0, 0]);
    expect(idx.districts.find((d) => d.month === "2021-07")!.index).toBe(3);
  });

  it("keeps the first-seen rule for the earlier detectors' rows", () => {
    const old: Sighting = { id: "o", month: "2021-03", lon: -2, lat: 6, areaHa: 4, ...base };
    const later: Sighting = { ...old, id: "o2", month: "2021-05", areaHa: 9 };
    const sites = assignSites([old, later]);
    expect(sites).toHaveLength(1);
    expect(newAreaIn(sites[0], "2021-03")).toBe(4);
    expect(newAreaIn(sites[0], "2021-05")).toBe(0);
  });

  it("never mixes the two kinds of rows into one site", () => {
    const old: Sighting = { id: "o", month: "2021-03", lon: -2, lat: 6, areaHa: 4, ...base };
    expect(assignSites([old, row("n", "2021-04", -2, 1)])).toHaveLength(2);
  });
});
