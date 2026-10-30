import { describe, expect, it } from "vitest";
import { parseCsv } from "@/pipeline/adapters/firms";
import { quantile } from "@/pipeline/adapters/glofas";
import { SOURCE_REGISTRY } from "@/pipeline/sources";

describe("parseCsv", () => {
  it("handles quoted fields and ragged rows", () => {
    const rows = parseCsv('a,b,c\n1,"x,y",3\n4,"say ""hi""",6\n');
    expect(rows).toEqual([
      { a: "1", b: "x,y", c: "3" },
      { a: "4", b: 'say "hi"', c: "6" },
    ]);
  });
  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("flood thresholds", () => {
  it("quantile interpolates linearly", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([10, 20], 0.8)).toBeCloseTo(18);
  });
});

describe("source registry", () => {
  it("has no sample or synthetic source and every entry declares its connection", () => {
    for (const s of SOURCE_REGISTRY) {
      expect(s.slug).not.toMatch(/synthetic|demo|sample/);
      expect(["live", "needs-key", "planned"]).toContain(s.connection);
      if (s.connection !== "live") expect(s.connectionNote).toBeTruthy();
    }
  });
});
