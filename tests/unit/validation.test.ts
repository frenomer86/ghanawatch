import { describe, expect, it } from "vitest";
import { bboxParam, clampBBox, cursorParam, encodeCursor, eventsQuery, reportBody, searchQuery } from "@/lib/domain/validation";

describe("bbox parsing", () => {
  it("parses and clamps to Ghana", () => {
    expect(bboxParam.parse("-10,-10,10,20")).toEqual([-3.4, 4.6, 1.3, 11.3]);
  });
  it("rejects inverted and malformed boxes", () => {
    expect(bboxParam.safeParse("1,1,0,0").success).toBe(false);
    expect(bboxParam.safeParse("a,b,c,d").success).toBe(false);
    expect(bboxParam.safeParse("1,2,3").success).toBe(false);
    expect(bboxParam.safeParse("1,2,3,4,5").success).toBe(false);
  });
  it("clampBBox never widens", () => {
    expect(clampBBox([-2, 5, 0, 8])).toEqual([-2, 5, 0, 8]);
  });
});

describe("events query", () => {
  it("applies defaults and strips nothing silently", () => {
    const q = eventsQuery.parse({});
    expect(q.limit).toBe(50);
    expect(q.format).toBe("json");
  });
  it("rejects unknown keys, bad enums and huge limits", () => {
    expect(eventsQuery.safeParse({ foo: "bar" }).success).toBe(false);
    expect(eventsQuery.safeParse({ type: "deforestation" }).success).toBe(false);
    expect(eventsQuery.safeParse({ limit: "100000" }).success).toBe(false);
    expect(eventsQuery.safeParse({ limit: "0" }).success).toBe(false);
  });
  it("rejects since in the far future", () => {
    expect(eventsQuery.safeParse({ since: "2999-01-01T00:00:00Z" }).success).toBe(false);
  });
  it("round-trips cursors and rejects forged ones", () => {
    const id = "01926a7e-0000-7000-8000-000000000001";
    const ts = new Date("2026-10-01T00:00:00Z");
    const parsed = cursorParam.parse(encodeCursor(ts, id));
    expect(parsed.id).toBe(id);
    expect(new Date(parsed.ts).getTime()).toBe(ts.getTime());
    expect(cursorParam.safeParse("' OR 1=1 --").success).toBe(false);
    expect(cursorParam.safeParse(Buffer.from("x|y").toString("base64url")).success).toBe(false);
  });
});

describe("search query", () => {
  it("accepts Twi letters and apostrophes, rejects SQL metacharacters", () => {
    expect(searchQuery.safeParse({ q: "Nkoranza" }).success).toBe(true);
    expect(searchQuery.safeParse({ q: "Twifo Atti-Morkwa" }).success).toBe(true);
    expect(searchQuery.safeParse({ q: "Ɔbuasi" }).success).toBe(true);
    expect(searchQuery.safeParse({ q: "a'); DROP TABLE users;--" }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "%" }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "a" }).success).toBe(false);
    expect(searchQuery.safeParse({ q: "x".repeat(81) }).success).toBe(false);
  });
});

describe("report body", () => {
  it("requires a location inside Ghana and bounded text", () => {
    expect(reportBody.safeParse({ lat: 6.7, lon: -1.6, description: "Fresh pits" }).success).toBe(true);
    expect(reportBody.safeParse({ lat: 48.8, lon: 2.3, description: "Paris" }).success).toBe(false);
    expect(reportBody.safeParse({ lat: 6.7, lon: -1.6, description: "" }).success).toBe(false);
    expect(reportBody.safeParse({ lat: 6.7, lon: -1.6, description: "x".repeat(501) }).success).toBe(false);
    expect(reportBody.safeParse({ lat: 6.7, lon: -1.6, description: "ok", extra: 1 }).success).toBe(false);
  });
});
