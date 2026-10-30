import { describe, expect, it } from "vitest";
import { MATCHING_TYPES, suggestVerdict } from "@/lib/server/reports/satellite-check";
import { roundPublic } from "@/lib/domain/cases";
import { REPORT_CATEGORIES } from "@/lib/domain/types";
import { caseUpdateBody, casesQuery, moderationBody, reportBody } from "@/lib/domain/validation";

describe("citizen report satellite check", () => {
  it("suggests a verdict from the number of matching detections", () => {
    expect(suggestVerdict(0)).toBe("not_visible_yet");
    expect(suggestVerdict(2)).toBe("confirmed_by_satellite");
  });

  it("has satellite evidence types for every report category", () => {
    for (const c of REPORT_CATEGORIES) expect(MATCHING_TYPES[c].length).toBeGreaterThan(0);
    expect(MATCHING_TYPES.fire).toEqual(["fire"]);
    expect(MATCHING_TYPES.galamsey).toContain("water_change");
  });

  it("rounds public coordinates to about 100 m", () => {
    expect(roundPublic(6.310123)).toBe(6.31);
    expect(roundPublic(-0.585649)).toBe(-0.586);
  });
});

describe("report and case validation", () => {
  const base = { lat: "6.3101", lon: "-0.5856", description: "Pits beside the road" };

  it("defaults the category and rejects unknown ones", () => {
    expect(reportBody.parse(base).category).toBe("other");
    expect(reportBody.parse({ ...base, category: "galamsey" }).category).toBe("galamsey");
    expect(reportBody.safeParse({ ...base, category: "poaching" }).success).toBe(false);
  });

  it("requires an authority when a case is passed on", () => {
    expect(caseUpdateBody.safeParse({ caseStatus: "passed_to_authority" }).success).toBe(false);
    expect(caseUpdateBody.safeParse({ caseStatus: "passed_to_authority", authority: "epa" }).success).toBe(true);
    expect(caseUpdateBody.safeParse({ caseStatus: "action_seen", note: "Pits refilled" }).success).toBe(true);
    expect(caseUpdateBody.safeParse({ caseStatus: "confirmed" }).success).toBe(false);
    expect(caseUpdateBody.safeParse({ caseStatus: "closed", note: "x".repeat(501) }).success).toBe(false);
  });

  it("accepts a satellite verdict with a moderation decision", () => {
    const at = "2026-10-17T00:00:00.000Z";
    expect(moderationBody.safeParse({ status: "approved", satelliteVerdict: "confirmed_by_satellite", expectedUpdatedAt: at }).success).toBe(true);
    expect(moderationBody.safeParse({ status: "approved", satelliteVerdict: "maybe", expectedUpdatedAt: at }).success).toBe(false);
  });

  it("limits the public case list", () => {
    expect(casesQuery.parse({}).limit).toBe(30);
    expect(casesQuery.safeParse({ limit: "500" }).success).toBe(false);
  });
});
