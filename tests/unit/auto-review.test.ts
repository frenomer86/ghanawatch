import { describe, expect, it } from "vitest";
import { decide, moderationNote, publicNote, verdictFor, type Evidence, type ReviewFacts } from "@/lib/domain/auto-review";

/** The rules that publish, reject or hold a citizen report without a moderator (src/lib/domain/auto-review.ts). */
const now = new Date("2026-11-04T12:00:00Z");
const base = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  reportedAt: "2026-11-04T11:58:00Z",
  lat: 6.2,
  lon: -1.9,
  accuracyM: null,
  locationSource: "pin",
  photo: null,
  safety: { nsfw: 0.02, faces: 0 },
  earlierSamePhoto: null,
  evidence: [],
  firstReviewedAt: "2026-11-04T11:59:00Z",
  checks: 0,
  ...over,
});
// 0.001 degree of latitude is about 111 m.
const photoAt = (dLatDeg: number, takenAt = "2026-11-04T09:00:00Z") => ({ lat: 6.2 + dLatDeg, lon: -1.9, accuracyM: 6, takenAt });
const sat: Evidence = { kind: "satellite", id: "e1", title: "Disturbed ground near a river", type: "surface_disturbance", date: "2026-10-20", distanceM: 310 };

describe("automatic approval", () => {
  it("publishes when the photo's own GPS position is within 500 m and the photo is recent", () => {
    const r = decide(base({ photo: photoAt(0.003) }), now);
    expect(r.decision).toBe("approve");
    expect(r.reasons).toEqual(["photo_matches"]);
    expect(r.photoDistanceM).toBeGreaterThan(300);
    expect(r.photoDistanceM).toBeLessThan(350);
  });

  it("widens the photo match to the phone's stated accuracy, up to 2 km", () => {
    expect(decide(base({ photo: { ...photoAt(0.008), accuracyM: 1200 } }), now).decision).toBe("approve");
    expect(decide(base({ photo: { ...photoAt(0.008), accuracyM: 20 } }), now).decision).toBe("hold");
  });

  it("publishes on satellite or sensor evidence alone, with the satellite verdict set", () => {
    const r = decide(base({ evidence: [sat] }), now);
    expect(r.decision).toBe("approve");
    expect(r.reasons).toEqual(["corroborated"]);
    expect(verdictFor(r, true)).toBe("confirmed_by_satellite");
    const rain = decide(base({ evidence: [{ kind: "heavy_rain", date: "2026-11-03", rainMm: 74 }] }), now);
    expect(rain.decision).toBe("approve");
    expect(verdictFor(rain, true)).toBe("not_visible_yet");
  });

  it("publishes when the phone placed the reporter on site and the photo is from the last two days", () => {
    const f = base({ locationSource: "device", accuracyM: 25, photo: { lat: null, lon: null, accuracyM: null, takenAt: "2026-11-03T16:00:00Z" } });
    expect(decide(f, now).reasons).toEqual(["on_site"]);
    expect(decide({ ...f, accuracyM: 400 }, now).decision).toBe("hold");
    expect(decide({ ...f, locationSource: "pin" }, now).decision).toBe("hold");
    expect(decide({ ...f, photo: { ...f.photo!, takenAt: "2026-10-25T16:00:00Z" } }, now).decision).toBe("hold");
  });

  it("measures the photo's age from when the report was made, for one that waited offline", () => {
    const f = base({ reportedAt: "2026-10-30T08:00:00Z", photo: photoAt(0.001, "2026-10-12T08:00:00Z") });
    expect(decide(f, now).photoAgeDays).toBe(18);
    expect(decide(f, now).decision).toBe("approve");
  });

  it("writes a public note with distances and dates but nothing about the reporter", () => {
    const f = base({ photo: photoAt(0.002, "2026-11-04T09:00:00Z"), evidence: [sat] });
    const note = publicNote(decide(f, now), f);
    expect(note).toMatch(/^Checked automatically: the photo's own GPS position is 2\d\d m from this spot and it was taken on 4 Nov 2026; and it matches disturbed ground near a river \(satellite, 20 Oct 2026, 310 m away\)\.$/);
  });
});

describe("automatic rejection", () => {
  it("rejects a photo that fails the safety screen, whatever else is true", () => {
    const r = decide(base({ safety: { nsfw: 0.93, faces: 0 }, evidence: [sat], photo: photoAt(0) }), now);
    expect(r.decision).toBe("reject");
    expect(r.reasons).toEqual(["unsafe_photo"]);
    expect(moderationNote(r, base())).toMatch(/safety screen/);
  });

  it("rejects a photo already used: a resubmission nearby, a reused picture far away", () => {
    expect(decide(base({ earlierSamePhoto: { id: "x", distanceM: 40 } }), now).reasons).toEqual(["duplicate"]);
    expect(decide(base({ earlierSamePhoto: { id: "x", distanceM: 90_000 } }), now).reasons).toEqual(["photo_reused"]);
  });

  it("rejects a photo whose GPS position is outside Ghana or more than 50 km away", () => {
    expect(decide(base({ photo: { lat: 51.5, lon: -0.12, accuracyM: 5, takenAt: "2026-11-01T10:00:00Z" } }), now).reasons).toEqual(["photo_outside_ghana"]);
    expect(decide(base({ photo: photoAt(0.6) }), now).reasons).toEqual(["photo_far"]);
  });

  it("rejects a photo taken more than a year before the report", () => {
    expect(decide(base({ photo: { lat: null, lon: null, accuracyM: null, takenAt: "2025-06-01T10:00:00Z" } }), now).reasons).toEqual(["photo_old"]);
  });

  it("ignores a camera clock set in the future rather than trusting or punishing it", () => {
    const r = decide(base({ photo: { lat: null, lon: null, accuracyM: null, takenAt: "2031-01-01T00:00:00Z" } }), now);
    expect(r.photoAgeDays).toBeNull();
    expect(r.decision).toBe("hold");
  });
});

describe("holding and closing", () => {
  it("holds a report with no evidence and checks again in three hours, then daily after three days", () => {
    const r = decide(base(), now);
    expect(r.decision).toBe("hold");
    expect(r.reasons).toEqual(["awaiting_evidence"]);
    expect(r.nextCheckAt).toBe("2026-11-04T15:00:00.000Z");
    const later = decide(base({ firstReviewedAt: "2026-10-30T12:00:00Z", checks: 20 }), now);
    expect(later.nextCheckAt).toBe("2026-11-05T12:00:00.000Z");
    expect(later.checks).toBe(21);
  });

  it("never publishes before the photo is screened, or when the safety score is borderline", () => {
    expect(decide(base({ safety: null, evidence: [sat] }), now).reasons).toEqual(["safety_unchecked"]);
    expect(decide(base({ safety: { nsfw: null, faces: 0 }, evidence: [sat] }), now).decision).toBe("hold");
    expect(decide(base({ safety: { nsfw: 0.6, faces: 0 }, evidence: [sat] }), now).reasons).toEqual(["possibly_unsafe_photo"]);
  });

  it("closes a report as unverified after 30 days with nothing to confirm it", () => {
    const r = decide(base({ firstReviewedAt: "2026-10-05T11:00:00Z", checks: 40 }), now);
    expect(r.decision).toBe("expire");
    expect(r.reasons).toEqual(["no_evidence"]);
    expect(r.nextCheckAt).toBeNull();
  });

  it("still publishes on the last day if evidence arrives", () => {
    expect(decide(base({ firstReviewedAt: "2026-10-05T11:00:00Z", evidence: [sat] }), now).decision).toBe("approve");
  });
});
