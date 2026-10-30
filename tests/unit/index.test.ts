import { describe, expect, it } from "vitest";
import { buildIndex, monthsBetween, previousMonth, rankMovement, type IndexDistrict } from "@/lib/domain/index";
import { assignSites, type Sighting } from "@/lib/domain/sites";
import { adjustedArea, wilson } from "@/lib/domain/uncertainty";

const sighting = (o: Partial<Sighting>): Sighting => ({
  id: Math.random().toString(36).slice(2),
  month: "2026-09",
  lon: -1.9,
  lat: 6.2,
  areaHa: 2,
  districtId: "A",
  likely: true,
  inReserve: false,
  reserve: null,
  inRiverBuffer: false,
  legality: "unknown",
  inMine: false,
  ...o,
});

const districts: IndexDistrict[] = [
  { id: "A", name: "Amansie Central", region: "Ashanti Region", areaKm2: 1000 },
  { id: "B", name: "Bibiani", region: "Western North Region", areaKm2: 500 },
];

describe("months", () => {
  it("lists months inclusively across a year end", () => {
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
});

describe("sites", () => {
  it("folds sightings within 200 m into one site that keeps its first month and first area, and tracks growth", () => {
    const sites = assignSites([
      sighting({ id: "x", month: "2026-07", areaHa: 1.5 }),
      sighting({ id: "y", month: "2026-09", lon: -1.9005, lat: 6.2005, areaHa: 3 }),
      sighting({ id: "z", month: "2026-09", lon: -1.95, areaHa: 2 }),
    ]);
    expect(sites).toHaveLength(2);
    const a = sites.find((s) => s.members.includes("x"))!;
    expect(a.firstMonth).toBe("2026-07");
    expect(a.lastMonth).toBe("2026-09");
    expect(a.areaHa).toBe(1.5);
    expect(a.maxAreaHa).toBe(3);
    expect(a.members).toEqual(["x", "y"]);
  });
  it("does not depend on the input order", () => {
    const list = [sighting({ id: "later", month: "2026-09", lon: -1.9004 }), sighting({ id: "early", month: "2026-06" })];
    expect(assignSites(list)[0].firstMonth).toBe("2026-06");
    expect(assignSites([...list].reverse())[0].firstMonth).toBe("2026-06");
  });
});

describe("the index", () => {
  it("counts a site once, in the month it was first seen, per 100 km², and ranks by the index", () => {
    const sites = assignSites([
      sighting({ id: "a1", month: "2026-08", areaHa: 10, districtId: "A" }),
      sighting({ id: "a2", month: "2026-09", lon: -1.9002, areaHa: 12, districtId: "A" }), // same site, re-seen: not new
      sighting({ id: "b1", month: "2026-09", lon: -2.3, lat: 6.4, areaHa: 6, districtId: "B", inReserve: true, reserve: "Tano Nimiri" }),
      sighting({ id: "m1", month: "2026-09", lon: -2.0, lat: 6.0, areaHa: 50, districtId: "A", inMine: true }), // licensed mine: never counted
      sighting({ id: "c1", month: "2026-09", lon: -2.1, lat: 6.1, areaHa: 4, districtId: "A", likely: false }), // cleared only: not counted
    ]);
    const { districts: rows, national } = buildIndex(sites, districts, ["2026-08", "2026-09"]);
    const a8 = rows.find((r) => r.districtId === "A" && r.month === "2026-08")!;
    const a9 = rows.find((r) => r.districtId === "A" && r.month === "2026-09")!;
    const b9 = rows.find((r) => r.districtId === "B" && r.month === "2026-09")!;
    expect(a8.newHa).toBe(10);
    expect(a8.index).toBe(1); // 10 ha per 1000 km² = 1 per 100 km²
    expect(a8.rank).toBe(1);
    expect(a9.newHa).toBe(0);
    expect(a9.cumHa).toBe(10);
    expect(a9.rank).toBeNull();
    expect(a9.activeSites).toBe(1);
    expect(b9.newHa).toBe(6);
    expect(b9.index).toBe(1.2);
    expect(b9.rank).toBe(1);
    expect(b9.pctForest).toBe(100);
    expect(national[1]).toMatchObject({ month: "2026-09", newHa: 6, cumHa: 16, districtsAffected: 1, topDistrictId: "B", inReservesHa: 6 });
  });
  it("adds a likely range when precision and detection rate are known", () => {
    const sites = assignSites([sighting({ id: "a", month: "2026-09", areaHa: 100 })]);
    const { national } = buildIndex(sites, districts, ["2026-09"], { precision: { k: 28, n: 30 }, detection: { k: 3, n: 10 } });
    expect(national[0].ciLow).toBeGreaterThan(0);
    expect(national[0].ciHigh).toBeGreaterThan(national[0].ciLow!);
    expect(national[0].ciHigh).toBeGreaterThan(100); // misses push the estimate above the mapped area
  });
  it("withholds the unlicensed share until a cadastre is loaded", () => {
    const sites = assignSites([sighting({ id: "a", month: "2026-09", legality: "unlicensed" })]);
    expect(buildIndex(sites, districts, ["2026-09"]).districts[0].pctUnlicensed).toBeNull();
    expect(buildIndex(sites, districts, ["2026-09"], { legalityKnown: true }).districts[0].pctUnlicensed).toBe(100);
  });
  it("describes rank movement", () => {
    expect(rankMovement(1, 3).arrow).toBe("up");
    expect(rankMovement(5, 2).arrow).toBe("down");
    expect(rankMovement(2, 2).arrow).toBe("same");
    expect(rankMovement(4, null).arrow).toBe("new");
    expect(rankMovement(null, 1).arrow).toBe("none");
  });
});

describe("uncertainty", () => {
  it("gives Wilson intervals that narrow with the sample", () => {
    const [lo10, hi10] = wilson(9, 10);
    const [lo100, hi100] = wilson(90, 100);
    expect(hi10 - lo10).toBeGreaterThan(hi100 - lo100);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
  it("corrects mapped area for false alarms and misses, with a floor on the detection rate", () => {
    const e = adjustedArea(100, { k: 28, n: 30 }, { k: 3, n: 10 });
    expect(e.estimate).toBeCloseTo((100 * 28) / 30 / 0.3, 0);
    expect(e.low).toBeLessThan(e.estimate);
    expect(e.high).toBeGreaterThan(e.estimate);
    const floor = adjustedArea(100, { k: 30, n: 30 }, { k: 0, n: 10 });
    expect(floor.estimate).toBe(1000);
    const noRate = adjustedArea(100, { k: 28, n: 30 });
    expect(noRate.detectionRate).toBeNull();
    expect(noRate.estimate).toBeCloseTo(93.3, 1);
  });
});

describe("find your district", () => {
  const names = ["Obuasi East", "Obuasi Municipal", "Amansie Central", "Amansie South", "Amansie West", "Kumasi Metropolitan", "Asokwa Municipal", "Tarkwa Nsuaem", "Prestea/huni Valley", "Bibiani-anhwiaso-bekwai Municipal"];
  it("sends a town name to its municipal district, not the first alphabetical match", async () => {
    const { resolveDistrict } = await import("@/lib/domain/find-district");
    expect(resolveDistrict("obuasi", names)).toBe("Obuasi Municipal");
    expect(resolveDistrict("Obuasi East", names)).toBe("Obuasi East");
    expect(resolveDistrict("kumasi", names)).toBe("Kumasi Metropolitan");
    expect(resolveDistrict("tarkwa", names)).toBe("Tarkwa Nsuaem");
    expect(resolveDistrict("Prestea Huni Valley", names)).toBe("Prestea/huni Valley");
    expect(resolveDistrict("bibiani", names)).toBe("Bibiani-anhwiaso-bekwai Municipal");
  });
  it("does not guess between several plain matches", async () => {
    const { resolveDistrict } = await import("@/lib/domain/find-district");
    expect(resolveDistrict("amansie", names)).toBeNull();
    expect(resolveDistrict("amansie west", names)).toBe("Amansie West");
    expect(resolveDistrict("", names)).toBeNull();
    expect(resolveDistrict("nowhere", names)).toBeNull();
  });
});
