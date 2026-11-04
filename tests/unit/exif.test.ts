import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPhotoMeta } from "@/lib/domain/exif";

/** Fixtures written by Pillow (an independent EXIF writer): Kumasi, 28 October 2026 09:15:30 GMT, a TECNO CAMON 20. */
const fx = (f: string) => readFileSync(join(process.cwd(), "tests/fixtures/exif", f));

describe("photo location and time from EXIF", () => {
  for (const f of ["gps.jpg", "gps.webp", "gps.png"]) {
    it(`reads position, accuracy, altitude, time and camera from ${f}`, () => {
      const m = readPhotoMeta(fx(f));
      expect(m.lat).toBeCloseTo(6.690167, 5);
      expect(m.lon).toBeCloseTo(-1.620083, 5);
      expect(m.accuracyM).toBe(8);
      expect(m.altitudeM).toBe(280.5);
      expect(m.takenAt).toBe("2026-10-28T09:15:30.000Z");
      expect(m.make).toBe("TECNO");
      expect(m.model).toBe("CAMON 20");
    });
  }

  it("returns empty fields for a photo without EXIF, and for a phone that had no GPS fix", () => {
    expect(readPhotoMeta(fx("plain.jpg"))).toMatchObject({ lat: null, lon: null, takenAt: null });
    const nofix = readPhotoMeta(fx("nofix.jpg"));
    expect(nofix.lat).toBeNull();
    expect(nofix.make).toBe("itel");
  });

  it("never throws on damaged or hostile input", () => {
    const good = fx("gps.jpg");
    for (let cut = 0; cut < good.length; cut += 7) expect(() => readPhotoMeta(good.subarray(0, cut))).not.toThrow();
    const noisy = Uint8Array.from(good);
    for (let i = 20; i < 200; i += 3) noisy[i] = (noisy[i] * 31 + 7) & 0xff;
    expect(() => readPhotoMeta(noisy)).not.toThrow();
    expect(readPhotoMeta(new Uint8Array(0)).lat).toBeNull();
  });
});

describe("photo time from the GPS fix", () => {
  it("uses the GPS date and UTC time when the camera wrote no clock time (Accra, 2 November 2026 14:05:09)", () => {
    const m = readPhotoMeta(fx("gpstime.jpg"));
    expect(m.lat).toBeCloseTo(5.56, 5);
    expect(m.lon).toBeCloseTo(-0.205, 5);
    expect(m.takenAt).toBe("2026-11-02T14:05:09.000Z");
  });
});
