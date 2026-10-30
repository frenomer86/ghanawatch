import { describe, expect, it } from "vitest";
import { classifyText, findPlace, parseRss } from "@/pipeline/adapters/news-signals";

describe("news signals", () => {
  it("reads title and summary text from RSS, without markup", () => {
    const xml = `<rss><channel><item><title><![CDATA[Galamsey operators destroy River Offin at Dunkwa]]></title><link>https://example.gh/a</link><pubDate>Fri, 16 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Residents of <b>Dunkwa-on-Offin</b> say&#8230;</p>]]></description></item></channel></rss>`;
    const [it] = parseRss(xml, "Test");
    expect(it.url).toBe("https://example.gh/a");
    expect(it.text).toContain("Residents of Dunkwa-on-Offin say");
    expect(it.text).not.toContain("<");
    expect(it.publishedAt?.toISOString()).toBe("2026-10-16T10:00:00.000Z");
  });

  it("recognises event types and leaves other news alone", () => {
    expect(classifyText("Illegal miners chased out of Atewa forest")).toBe("galamsey");
    expect(classifyText("VRA to begin spillage of Akosombo dam")).toBe("dam_spill");
    expect(classifyText("Torrential rain floods parts of Kasoa")).toBe("flood");
    expect(classifyText("Odwira celebrated with a heavy downpour")).toBeNull();
    expect(classifyText("Dumsor returns to parts of Accra")).toBe("power_cut");
    expect(classifyText("Black Stars beat Mali 2-0")).toBeNull();
  });

  it("matches whole place names, longest first", () => {
    const places = ["Dunkwa-on-Offin", "Dunkwa", "Kwahu", "Council"].map((name) => ({ name, re: new RegExp(`(^|[^\\p{L}])${name}([^\\p{L}]|$)`, "u") }));
    expect(findPlace("Mining at Dunkwa-on-Offin again", places)).toBe(0);
    expect(findPlace("Kwahuman people protest", places)).toBe(-1);
    expect(findPlace("Galamsey raised at Christian Council meeting", places)).toBe(-1);
  });
});
