import { describe, expect, it } from "vitest";
import { docx, zipStore } from "@/lib/server/docx";
import { digestText } from "@/lib/server/alerts/digest";
import { chainSections, distanceToLineM, reaches, riverLengthKm, RiverIndex } from "@/lib/geo/rivers";

describe("docx", () => {
  it("writes a stored zip with the Word parts Word needs", () => {
    const buf = docx("Test", [{ text: "Title", style: "Title" }, { text: "Hello\nworld" }]);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    const text = buf.toString("latin1");
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("word/document.xml");
    expect(text).toContain("<w:br/>");
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  });
  it("records entry count and central directory offsets", () => {
    const z = zipStore([
      ["a.txt", "aaa"],
      ["b/c.txt", Buffer.from("bbb")],
    ]);
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(2);
  });
});

describe("weekly digest text", () => {
  const origin = "https://ghanawatch.example";
  it("stays under 1,000 characters and lists the worst districts first", () => {
    const districts = Array.from({ length: 12 }, (_, i) => ({
      districtId: `d${i}`,
      name: `District number ${i} with a long name`,
      slug: `d${i}`,
      region: "Ashanti Region",
      ha: 50 - i,
      sites: [{ id: `s${i}`, title: "Likely mining pits", areaHa: 5, firstSeen: "2026-10-20", reserve: i === 0 ? "Atewa Range" : null, url: `${origin}/event/s${i}` }],
    }));
    const text = digestText({ weekEnding: "2026-10-26", since: "2026-10-19", newSites: 12, newHa: 500, districts }, origin);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("District number 0");
    expect(text).toContain("inside Atewa Range");
    expect(text).toContain("more districts");
  });
  it("says so when nothing was found", () => {
    expect(digestText({ weekEnding: "2026-10-26", since: "2026-10-19", newSites: 0, newHa: 0, districts: [] }, origin)).toContain("No new sites");
  });
});

describe("river geometry", () => {
  const line = { river: "Pra", coords: [[-1.6, 5.2], [-1.6, 5.3], [-1.6, 5.4], [-1.6, 5.5]] };
  it("measures distance to a line in metres", () => {
    expect(distanceToLineM(-1.6, 5.35, line.coords)).toBeLessThan(1);
    expect(distanceToLineM(-1.61, 5.35, line.coords)).toBeGreaterThan(1000);
  });
  it("cuts a river into reaches of about the asked length", () => {
    expect(riverLengthKm([line])).toBe(33);
    const r = reaches([line], 10);
    expect(r.length).toBeGreaterThanOrEqual(3);
    expect(r[0].startKm).toBe(0);
    expect(r.at(-1)!.endKm).toBe(33);
  });
  it("orders shuffled river sections head to mouth and measures km continuously", () => {
    // Three sections of one river given out of order, the middle one reversed.
    const a = { river: "Test", coords: [[-1.0, 6.0], [-1.0, 6.05], [-1.0, 6.1]] };
    const b = { river: "Test", coords: [[-1.0, 6.2], [-1.0, 6.15], [-1.0, 6.1]] }; // reversed
    const c = { river: "Test", coords: [[-1.0, 6.2], [-1.0, 6.25], [-1.0, 6.3]] };
    const chained = chainSections([c, a, b]);
    expect(chained).toHaveLength(1);
    expect(chained[0].coords.length).toBe(9);
    const r = reaches([c, a, b], 10);
    expect(r[0].startKm).toBe(0);
    for (let i = 1; i < r.length; i++) expect(r[i].startKm).toBe(r[i - 1].endKm);
    expect(r.at(-1)!.endKm).toBe(riverLengthKm([a, b, c]));
  });
  it("indexes lines for nearest lookups", () => {
    const idx = new RiverIndex([line]);
    expect(idx.nearest(-1.6, 5.25, 100)?.river).toBe("Pra");
    expect(idx.nearest(-1.7, 5.25, 100)).toBeNull();
  });
});

describe("hardening", () => {
  it("quotes CSV cells that a spreadsheet would run as a formula", async () => {
    const { csvEscape } = await import("@/lib/server/release/files");
    expect(csvEscape("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(csvEscape("=HYPERLINK(\"x\"),y")).toBe(`"'=HYPERLINK(""x""),y"`);
    expect(csvEscape("+1 234")).toBe("'+1 234");
    expect(csvEscape(-3.5)).toBe("-3.5");
    expect(csvEscape("Obuasi, Municipal")).toBe(`"Obuasi, Municipal"`);
    expect(csvEscape(null)).toBe("");
  });
  it("refuses dates that only look like dates", async () => {
    const { accuracyCheckBody, correctionBody, subscribeBody } = await import("@/lib/domain/validation");
    const base = { label: "Whole-of-Ghana optical check", kind: "optical", checked: 30, correct: 28 };
    expect(accuracyCheckBody.safeParse({ ...base, checkedOn: "2026-10-02" }).success).toBe(true);
    expect(accuracyCheckBody.safeParse({ ...base, checkedOn: "2026-13-99" }).success).toBe(false);
    expect(accuracyCheckBody.safeParse({ ...base, checkedOn: "2026-02-30" }).success).toBe(false);
    expect(correctionBody.safeParse({ publishedOn: "2026-02-30", indexVersion: "1.0", whatChanged: "abcdef", why: "abcdef" }).success).toBe(false);
    expect(subscribeBody.safeParse({ email: "a@b.co\r\nBcc: x@y.z" }).success).toBe(false);
    expect(subscribeBody.safeParse({ email: "a@b.co", district: "../x" }).success).toBe(false);
    expect(subscribeBody.safeParse(JSON.parse('{"email":"a@b.co","__proto__":{"admin":true}}')).success).toBe(false); // strict(): the key is refused, never merged
  });
});
