import { describe, expect, it } from "vitest";
import { buildDistrictCards, buildReserveCards, scoreKind, shareOfArea, slugify, type ScoreEventRow } from "@/lib/domain/scorecards";

const now = new Date("2026-10-17T12:00:00Z");
const ev = (o: Partial<ScoreEventRow>): ScoreEventRow => ({
  districtId: "d1",
  type: "surface_disturbance",
  methodVersion: "s2-galamsey-2.0",
  signature: "cleared_with_pits",
  confidence: "medium",
  severity: "watch",
  areaHa: 1,
  reserve: null,
  mine: null,
  nearPeople: false,
  detectedAt: now,
  firstSeen: now,
  ...o,
});

describe("scorecard lines", () => {
  it("counts pits as likely mining only with at least medium confidence, and keeps bare clearing apart", () => {
    expect(scoreKind(ev({}))).toEqual({ kind: "mining", likely: true });
    expect(scoreKind(ev({ signature: "new_pits", confidence: "low" }))).toEqual({ kind: "possible", likely: false });
    expect(scoreKind(ev({ signature: "cleared" }))).toEqual({ kind: "cleared", likely: false });
    expect(scoreKind(ev({ type: "water_change", signature: "turbid_water" }))).toEqual({ kind: "muddy", likely: false });
    expect(scoreKind(ev({ type: "water_change", methodVersion: "s1-water-1.0", signature: null, confidence: "medium" }))).toEqual({ kind: "radar", likely: true });
    expect(scoreKind(ev({ type: "water_change", methodVersion: "s1-water-1.0", signature: null, confidence: "low" }))).toEqual({ kind: "radar", likely: false });
    expect(scoreKind(ev({ type: "fire", methodVersion: "firms-viirs-1.1" })).kind).toBe("fire");
  });

  it("ranks districts by likely mining, leaving out the work of named large-scale mines", () => {
    const cards = buildDistrictCards({
      districts: [
        { id: "d1", name: "Amansie West", region: "Ashanti Region", areaKm2: 1000 },
        { id: "d2", name: "Tarkwa-Nsuaem Municipal", region: "Western Region", areaKm2: 500 },
        { id: "d3", name: "Keta Municipal", region: "Volta Region", areaKm2: 800 },
      ],
      events: [
        ev({ districtId: "d1", areaHa: 4, reserve: "Bonsa Forest Reserve", nearPeople: true, severity: "urgent" }),
        ev({ districtId: "d1", areaHa: 2, signature: "cleared" }),
        ev({ districtId: "d1", areaHa: 3, type: "water_change", methodVersion: "s1-water-1.0", signature: null, firstSeen: new Date("2026-09-20T00:00:00Z") }),
        ev({ districtId: "d2", areaHa: 50, mine: "Gold Fields Tarkwa Mine" }),
        ev({ districtId: "d2", areaHa: 1 }),
        ev({ districtId: "d3", type: "water_change", signature: "turbid_water", areaHa: 5 }),
      ],
      fires7d: new Map([["d1", 3]]),
      firesUsual7d: new Map([["d1", 1.5]]),
      reports: new Map([["d1", { approved: 2, confirmed: 1 }]]),
      now,
    });
    const [a, t, k] = cards;
    expect(a.name).toBe("Amansie West");
    expect(a).toMatchObject({ rank: 1, miningHa: 7, miningSites: 2, radarHa: 3, clearedHa: 2, inReservesHa: 4, nearPeople: 1, urgent: 1, newThisMonthHa: 4, fires7d: 3, firesUsual7d: 1.5, reports: 2 });
    expect(a.reserves).toEqual(["Bonsa Forest Reserve"]);
    expect(t).toMatchObject({ name: "Tarkwa-Nsuaem Municipal", rank: 2, miningHa: 1, inMinesHa: 50, slug: "tarkwa-nsuaem-municipal" });
    expect(k).toMatchObject({ rank: null, miningHa: 0, muddyRivers: 1, muddyRiversHa: 5 });
  });

  it("summarises forest reserves from the detections inside them", () => {
    const reserves = buildReserveCards(
      [ev({ reserve: "Atewa Range Forest Reserve", areaHa: 2 }), ev({ reserve: "Atewa Range Forest Reserve", signature: "cleared", areaHa: 1, districtId: "d2" }), ev({ reserve: "Subika", mine: "Subika Pit (Newmont)" })],
      new Map([
        ["d1", "Atiwa West"],
        ["d2", "Abuakwa North Municipal"],
      ]),
    );
    expect(reserves).toEqual([
      { name: "Atewa Range Forest Reserve", slug: "atewa-range-forest-reserve", miningHa: 2, miningSites: 1, clearedHa: 1, districts: ["Abuakwa North Municipal", "Atiwa West"], nearPeople: 0 },
    ]);
  });

  it("makes stable addresses and shares of land", () => {
    expect(slugify("Ga East Municipal")).toBe("ga-east-municipal");
    expect(slugify("Sefwi-Wiawso Municipal")).toBe("sefwi-wiawso-municipal");
    expect(shareOfArea(250, 500)).toBe(0.5);
    expect(shareOfArea(1, null)).toBeNull();
  });
});
