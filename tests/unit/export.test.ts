import { describe, expect, it } from "vitest";
import { csvEscape } from "@/lib/server/export";
import { formatHectares, maxSeverity } from "@/lib/domain/format";
import { uuidv7, stableId } from "@/lib/server/ids";

describe("csvEscape", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });
  it("neutralises spreadsheet formula injection", () => {
    // Quoted because it contains quotes; the leading apostrophe still defuses the formula.
    expect(csvEscape('=HYPERLINK("http://evil")')).toMatch(/^"?'=HYPERLINK/);
    expect(csvEscape("+1")).toBe("'+1");
    expect(csvEscape("-5")).toBe("-5");
    expect(csvEscape(-2.70006)).toBe("-2.70006");
    expect(csvEscape("-5 apples")).toBe("'-5 apples");
    expect(csvEscape("@cmd")).toBe("'@cmd");
  });
  it("passes plain values and empties", () => {
    expect(csvEscape("Amansie West")).toBe("Amansie West");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(12.5)).toBe("12.5");
  });
});

describe("format helpers", () => {
  it("formats hectares by magnitude", () => {
    expect(formatHectares(0.42)).toBe("0.42 ha");
    expect(formatHectares(12.34)).toBe("12.3 ha");
    expect(formatHectares(1234.5)).toMatch(/1,?235 ha/);
    expect(formatHectares(null)).toBe("–");
  });
  it("maxSeverity picks the highest", () => {
    expect(maxSeverity(["normal", "elevated", "watch"])).toBe("elevated");
    expect(maxSeverity([])).toBe("normal");
  });
});

describe("ids", () => {
  it("uuidv7 is time-ordered and well-formed", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
  it("stableId is deterministic and namespaced", () => {
    expect(stableId("x", "y")).toBe(stableId("x", "y"));
    expect(stableId("x", "y")).not.toBe(stableId("z", "y"));
  });
});
