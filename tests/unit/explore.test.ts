import { describe, expect, it } from "vitest";
import { clearestPerMonth, frameMetrics, parseSceneId, passCorners, tciUrl } from "@/lib/server/explore/passes";
import { parseConfig, parseSrcDate, pickFinest, probeSet } from "@/lib/server/explore/wayback";
import { commonsDate, plainText } from "@/lib/server/explore/ground";
import { isPublicHttpsUrl } from "@/lib/server/explore/fetch";
import {
  appleMapsSatelliteUrl,
  bingAerialUrl,
  googleEarthUrl,
  googleMapsSatelliteUrl,
  googleStreetViewUrl,
  groundViewHref,
  maxTileZoom,
  openStreetMapUrl,
} from "@/lib/explore/imagery";
import { explorePointQuery, passQuery, sightingBody, sightingReviewBody, streetPhotoQuery } from "@/lib/domain/validation";
import { haversineKm } from "@/lib/geo";

describe("Sentinel-2 scene ids", () => {
  it("parses Earth Search ids, including Sentinel-2C", () => {
    expect(parseSceneId("S2C_30NWM_20260125_0_L2A")).toEqual({ zone: 30, band: "N", square: "WM", year: 2026, month: 1, day: 25 });
    expect(parseSceneId("S2B_31NBH_20251126_1_L2A")?.zone).toBe(31);
    expect(parseSceneId("S2B_30NWM_20251126_0_L1C")).toBeNull();
    expect(parseSceneId("../../etc/passwd")).toBeNull();
  });

  it("builds the true-colour COG URL with an unpadded month", () => {
    expect(tciUrl("S2B_30NWM_20260125_0_L2A")).toBe(
      "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/30/N/WM/2026/1/S2B_30NWM_20260125_0_L2A/TCI.tif",
    );
    expect(tciUrl("not-a-scene")).toBeNull();
  });

  it("draws a 4 km square around the point, corners clockwise from top-left", () => {
    const [tl, tr, br, bl] = passCorners(32630, -2.49, 6.205);
    expect(tl[1]).toBeGreaterThan(bl[1]);
    expect(tr[0]).toBeGreaterThan(tl[0]);
    expect(br[1]).toBeLessThan(tr[1]);
    const side = haversineKm({ lon: tl[0], lat: tl[1] }, { lon: tr[0], lat: tr[1] });
    expect(side).toBeGreaterThan(3.95);
    expect(side).toBeLessThan(4.05);
  });
});

describe("recent passes", () => {
  it("keeps the clearest pass of each month, oldest first, one per date", () => {
    const out = clearestPerMonth([
      { scene: "a", date: "2026-03-31", tileCloud: 17 },
      { scene: "b", date: "2026-03-01", tileCloud: 41 },
      { scene: "c", date: "2026-01-25", tileCloud: 2 },
      { scene: "d", date: "2026-01-25", tileCloud: 30 },
      { scene: "e", date: "2026-01-05", tileCloud: 44 },
    ]);
    expect(out.map((s) => s.scene)).toEqual(["c", "a"]);
  });

  it("measures bright cloud and out-of-swath pixels", () => {
    const rgb = new Uint8Array([0, 0, 0, 250, 250, 250, 40, 80, 30, 255, 210, 140]);
    const m = frameMetrics(rgb);
    expect(m.nodata).toBeCloseTo(0.25);
    // Bright laterite (blue under 200) is not cloud.
    expect(m.cloud).toBeCloseTo(0.25);
  });
});

describe("Esri Wayback", () => {
  const config = {
    "63116": { itemTitle: "World Imagery (Wayback 2026-09-24)", metadataLayerUrl: "https://metadata.example/2026_r09/MapServer" },
    "62000": { itemTitle: "World Imagery (Wayback 2026-01-10)", metadataLayerUrl: "https://metadata.example/2026_r01/MapServer" },
    "50000": { itemTitle: "World Imagery (Wayback 2025-11-02)", metadataLayerUrl: "https://metadata.example/2025_r11/MapServer" },
    "40000": { itemTitle: "World Imagery (Wayback 2025-03-02)", metadataLayerUrl: "https://metadata.example/2025_r03/MapServer" },
    "10": { itemTitle: "World Imagery (Wayback 2014-02-20)", metadataLayerUrl: "https://metadata.example/2014_r01/MapServer" },
    bad: { itemTitle: "x", metadataLayerUrl: "http://insecure.example" },
  };

  it("parses releases newest first and probes the newest of each year plus the first", () => {
    const releases = parseConfig(config);
    expect(releases.map((r) => r.release)).toEqual([63116, 62000, 50000, 40000, 10]);
    expect(probeSet(releases).map((r) => r.release)).toEqual([63116, 50000, 10]);
  });

  it("reads capture dates in both published formats", () => {
    expect(parseSrcDate(20221221)).toBe("2022-12-21");
    expect(parseSrcDate("12/21/2022")).toBe("2022-12-21");
    expect(parseSrcDate("")).toBeNull();
  });

  it("takes the finest-resolution metadata layer at the point", () => {
    const c = pickFinest([
      { layerId: 9, attributes: { SRC_DATE: "20190101", SRC_RES: "15", SRC_DESC: "Terracolor", NICE_DESC: "Earthstar" } },
      { layerId: 5, attributes: { SRC_DATE: "20221221", SRC_RES: "0.5", SRC_DESC: "WV02", NICE_DESC: "Vantor" } },
    ]);
    expect(c).toEqual({ capturedOn: "2022-12-21", provider: "Vantor", sensor: "WorldView-2", resolutionM: 0.5, maxLevel: null });
    expect(pickFinest([{ layerId: 1 }])).toBeNull();
  });
});

describe("ground photos", () => {
  it("keeps only the text of Commons metadata", () => {
    expect(plainText('<a href="x">Jane &amp; John</a>\n Doe')).toBe("Jane & John Doe");
    expect(plainText("<p></p>")).toBeNull();
    expect(plainText(42)).toBeNull();
  });

  it("finds the date in Commons date fields", () => {
    expect(commonsDate("2019-08-17 10:22:31")).toBe("2019-08-17");
    expect(commonsDate('<time class="dtstart" datetime="2021-05">May 2021</time>')).toBe("2021-05");
    expect(commonsDate("circa 1915")).toBe("1915");
    expect(commonsDate("unknown")).toBeNull();
  });
});

describe("outbound URLs", () => {
  it("only allows public https hosts for proxied photos", () => {
    expect(isPublicHttpsUrl("https://panoramax.openstreetmap.fr/images/a.jpg")).toBe(true);
    expect(isPublicHttpsUrl("http://panoramax.openstreetmap.fr/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://127.0.0.1/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://[::1]/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://user:pw@example.org/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://example.org:8443/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
  });

  it("builds the outbound links for a spot", () => {
    expect(googleStreetViewUrl(6.2, -2.49)).toBe("https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=6.200000,-2.490000");
    expect(googleEarthUrl(6.2, -2.49)).toContain("earth.google.com/web/@6.200000,-2.490000,");
    expect(openStreetMapUrl(6.2, -2.49)).toContain("mlat=6.200000&mlon=-2.490000");
    expect(groundViewHref(6.2, -2.49, "abc")).toBe("/explore?lat=6.20000&lon=-2.49000&event=abc");
    expect(groundViewHref(6.2, -2.49, null, { mode: "machinery", release: 63116 })).toBe("/explore?lat=6.20000&lon=-2.49000&mode=machinery&release=63116");
  });

  it("asks for close-up tiles only as deep as each capture goes", () => {
    expect(maxTileZoom({ resolutionM: 0.31, maxLevel: 18 })).toBe(18);
    expect(maxTileZoom({ resolutionM: 1, maxLevel: null })).toBe(17);
    expect(maxTileZoom({ resolutionM: 0.5, maxLevel: null })).toBe(18);
    expect(maxTileZoom(null)).toBe(18);
  });

  it("links to newer imagery on Google Maps, Bing and Apple Maps without embedding it", () => {
    expect(googleMapsSatelliteUrl(6.31, -0.5856)).toBe("https://www.google.com/maps/@?api=1&map_action=map&center=6.310000,-0.585600&zoom=19&basemap=satellite");
    expect(bingAerialUrl(6.31, -0.5856)).toBe("https://www.bing.com/maps?cp=6.310000~-0.585600&lvl=19&style=a");
    expect(appleMapsSatelliteUrl(6.31, -0.5856)).toBe("https://maps.apple.com/?ll=6.310000,-0.585600&z=19&t=k");
  });
});

describe("Ground view input validation", () => {
  it("accepts points in Ghana and rejects points far outside", () => {
    expect(explorePointQuery.safeParse({ lat: "6.2", lon: "-2.49" }).success).toBe(true);
    expect(explorePointQuery.safeParse({ lat: "48.8", lon: "2.35" }).success).toBe(false);
    expect(explorePointQuery.safeParse({ lat: "6.2", lon: "-2.49", extra: "1" }).success).toBe(false);
  });

  it("accepts only well-formed scene ids for satellite passes", () => {
    expect(passQuery.safeParse({ scene: "S2B_30NWM_20261002_0_L2A", lat: "6.2", lon: "-2.49" }).success).toBe(true);
    expect(passQuery.safeParse({ scene: "S2B_30NWM_20261002_0_L2A/../x", lat: "6.2", lon: "-2.49" }).success).toBe(false);
  });

  it("validates machinery tags", () => {
    const ok = { lat: 6.31, lon: -0.5856, kind: "excavator", count: 2, release: 63116, capturedOn: "2023-01-01", sensor: "WorldView-3" };
    expect(sightingBody.safeParse(ok).success).toBe(true);
    expect(sightingBody.safeParse({ ...ok, kind: "tank" }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, count: 0 }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, count: 51 }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, capturedOn: "1 Jan 2023" }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, sensor: "<script>" }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, note: "x".repeat(281) }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, lat: 51.5 }).success).toBe(false);
    expect(sightingBody.safeParse({ ...ok, status: "confirmed" }).success).toBe(false);
    expect(sightingReviewBody.safeParse({ status: "confirmed", expectedUpdatedAt: "2026-10-16T22:00:00.000Z" }).success).toBe(true);
    expect(sightingReviewBody.safeParse({ status: "pending", expectedUpdatedAt: "2026-10-16T22:00:00.000Z" }).success).toBe(false);
  });

  it("accepts only known providers and plain ids for street photos", () => {
    expect(streetPhotoQuery.safeParse({ src: "panoramax", id: "cf093731-3398-4500-a890-21f1796ddb0b" }).success).toBe(true);
    expect(streetPhotoQuery.safeParse({ src: "flickr", id: "123456" }).success).toBe(false);
    expect(streetPhotoQuery.safeParse({ src: "mapillary", id: "https://evil.example/x" }).success).toBe(false);
  });
});
