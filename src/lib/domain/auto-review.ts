import { haversineKm } from "@/lib/geo";
import type { LocationSource, SatelliteVerdict } from "./types";

/**
 * Automatic verification of citizen reports: the rules that publish, reject or hold a report without a
 * moderator. Pure, so every rule is unit-tested; src/lib/server/reports/auto-review.ts gathers the facts and
 * applies the decision.
 *
 * A report is published when at least one independent line of evidence ties it to the place and time it
 * claims:
 *   - the photo's own GPS position (written by the camera, read from the original file before it is
 *     re-encoded) is within 500 m of the reported spot (or within the phone's stated accuracy, if wider) and
 *     the photo was taken within 30 days of the report;
 *   - GhanaWatch's sensors saw something matching at the spot: a satellite detection of a matching kind within
 *     750 m, a radar flood outline containing the spot, a satellite fire within 2 km and 3 days, the detection
 *     the reporter linked within 2 km, heavy rain over the district within two days of a flood report, or
 *     another person's report of the same kind within 1 km and 7 days;
 *   - the phone placed the reporter on site (location from the device, accurate to 100 m) and the photo was
 *     taken within two days of the report.
 * It is rejected when the photo fails the safety screen, was already used for an earlier report, carries a GPS
 * position outside Ghana or more than 50 km away, or was taken more than a year earlier. Anything else is held
 * and checked again as new satellite passes arrive (every three hours for three days, then daily); a report
 * with no evidence after 30 days is closed as unverified. A moderator can still decide any report, and the
 * reviewer never touches one a moderator has decided.
 */

export const AUTO_REVIEW_VERSION = "auto-1.0";

export { LOCATION_SOURCES, type LocationSource } from "./types";

export const REVIEW_RULES = {
  /** The photo's GPS position must be this close to the reported spot to vouch for it (or the stated accuracy). */
  photoMatchM: 500,
  photoMatchMaxM: 2000,
  /** ... and the photo no older than this when reported. */
  photoMatchMaxAgeDays: 30,
  /** Device location this accurate, with a photo this fresh, places the reporter on site. */
  deviceAccuracyM: 100,
  freshPhotoDays: 2,
  /** A photo GPS position farther than this from the reported spot is a different place. */
  photoFarKm: 50,
  /** A photo older than this is not evidence of anything happening now. */
  photoTooOldDays: 365,
  /** Classifier scores: reject at or above, never publish automatically at or above. */
  nsfwReject: 0.85,
  nsfwHold: 0.5,
  /** Same photo as an earlier report within this distance: a resubmission; farther: a reused picture. */
  duplicateM: 1000,
  /** Held reports are closed as unverified after this long. */
  expireDays: 30,
} as const;

/** Ghana's outline box with a margin of about 10 km, for photo positions. */
const GHANA = { minLon: -3.35, maxLon: 1.3, minLat: 4.6, maxLat: 11.25 };

export type Evidence =
  | { kind: "satellite"; id: string; title: string; type: string; date: string; distanceM: number }
  | { kind: "fire_hotspot"; date: string; distanceM: number; source: string }
  | { kind: "linked_detection"; id: string; title: string; distanceM: number }
  | { kind: "heavy_rain"; date: string; rainMm: number }
  | { kind: "other_reports"; count: number; nearestM: number };

export interface PhotoFacts {
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  takenAt: string | null;
}

export interface ReviewFacts {
  /** When the reporter made the report: when it was queued offline, else when it arrived. */
  reportedAt: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  locationSource: LocationSource;
  photo: PhotoFacts | null;
  /** Null until the photo screen has run. */
  safety: { nsfw: number | null; faces: number } | null;
  /** An earlier report with the very same photo file. */
  earlierSamePhoto: { id: string; distanceM: number } | null;
  evidence: Evidence[];
  /** When the reviewer first looked at the report. */
  firstReviewedAt: string;
  checks: number;
}

export type ReviewDecision = "approve" | "reject" | "hold" | "expire";
export type ReviewReason =
  | "unsafe_photo"
  | "possibly_unsafe_photo"
  | "safety_unchecked"
  | "duplicate"
  | "photo_reused"
  | "photo_outside_ghana"
  | "photo_far"
  | "photo_old"
  | "photo_matches"
  | "corroborated"
  | "on_site"
  | "awaiting_evidence"
  | "no_evidence";

export interface AutoReview {
  version: string;
  at: string;
  decision: ReviewDecision;
  reasons: ReviewReason[];
  /** Distance from the photo's GPS position to the reported spot, metres. */
  photoDistanceM: number | null;
  /** Days between the photo being taken and the report. */
  photoAgeDays: number | null;
  evidence: Evidence[];
  safety: { nsfw: number | null; faces: number } | null;
  firstReviewedAt: string;
  checks: number;
  nextCheckAt: string | null;
}

const DAY = 86_400_000;

export function photoDistanceM(f: Pick<ReviewFacts, "lat" | "lon" | "photo">): number | null {
  if (f.photo?.lat == null || f.photo.lon == null) return null;
  return Math.round(haversineKm({ lon: f.lon, lat: f.lat }, { lon: f.photo.lon, lat: f.photo.lat }) * 1000);
}

/** Days from the photo to the report; null when unknown or when the camera clock is plainly wrong (in the future). */
export function photoAgeDays(f: Pick<ReviewFacts, "reportedAt" | "photo">): number | null {
  if (!f.photo?.takenAt) return null;
  const age = (Date.parse(f.reportedAt) - Date.parse(f.photo.takenAt)) / DAY;
  if (!Number.isFinite(age) || age < -1) return null;
  return Math.max(0, Math.round(age * 10) / 10);
}

/** When to look at a held report again: every three hours for its first three days, then once a day. */
export function nextCheck(now: Date, firstReviewedAt: string): Date {
  const age = now.getTime() - Date.parse(firstReviewedAt);
  return new Date(now.getTime() + (age < 3 * DAY ? 3 * 3_600_000 : DAY));
}

export function decide(f: ReviewFacts, now: Date): AutoReview {
  const R = REVIEW_RULES;
  const dist = photoDistanceM(f);
  const age = photoAgeDays(f);
  const base = {
    version: AUTO_REVIEW_VERSION,
    at: now.toISOString(),
    photoDistanceM: dist,
    photoAgeDays: age,
    evidence: f.evidence,
    safety: f.safety,
    firstReviewedAt: f.firstReviewedAt,
    checks: f.checks + 1,
  };
  const done = (decision: ReviewDecision, reasons: ReviewReason[]): AutoReview => ({ ...base, decision, reasons, nextCheckAt: null });

  // Rejections: the photo itself rules the report out.
  if (f.safety?.nsfw != null && f.safety.nsfw >= R.nsfwReject) return done("reject", ["unsafe_photo"]);
  if (f.earlierSamePhoto) return done("reject", [f.earlierSamePhoto.distanceM <= R.duplicateM ? "duplicate" : "photo_reused"]);
  if (f.photo?.lat != null && f.photo.lon != null) {
    const { lat, lon } = f.photo;
    if (lon < GHANA.minLon || lon > GHANA.maxLon || lat < GHANA.minLat || lat > GHANA.maxLat) return done("reject", ["photo_outside_ghana"]);
    if (dist != null && dist > R.photoFarKm * 1000) return done("reject", ["photo_far"]);
  }
  if (age != null && age > R.photoTooOldDays) return done("reject", ["photo_old"]);

  // Publishing needs a screened photo.
  const blockers: ReviewReason[] = [];
  if (!f.safety || f.safety.nsfw == null) blockers.push("safety_unchecked");
  else if (f.safety.nsfw >= R.nsfwHold) blockers.push("possibly_unsafe_photo");

  const reasons: ReviewReason[] = [];
  const matchM = Math.min(R.photoMatchMaxM, Math.max(R.photoMatchM, f.photo?.accuracyM ?? 0));
  if (dist != null && dist <= matchM && age != null && age <= R.photoMatchMaxAgeDays) reasons.push("photo_matches");
  if (f.evidence.length > 0) reasons.push("corroborated");
  if (f.locationSource === "device" && f.accuracyM != null && f.accuracyM <= R.deviceAccuracyM && age != null && age <= R.freshPhotoDays) reasons.push("on_site");

  if (reasons.length && !blockers.length) return done("approve", reasons);
  if (now.getTime() - Date.parse(f.firstReviewedAt) >= R.expireDays * DAY) return done("expire", ["no_evidence"]);
  return { ...base, decision: "hold", reasons: blockers.length ? blockers : ["awaiting_evidence"], nextCheckAt: nextCheck(now, f.firstReviewedAt).toISOString() };
}

/** The public satellite verdict an automatic approval sets: confirmed when a satellite saw it. */
export function verdictFor(review: AutoReview, satelliteChecked: boolean): SatelliteVerdict {
  if (review.evidence.some((e) => e.kind === "satellite" || e.kind === "fire_hotspot" || e.kind === "linked_detection")) return "confirmed_by_satellite";
  return satelliteChecked ? "not_visible_yet" : "under_review";
}

const fmtDay = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const km = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

/** One line per piece of evidence, for the public case trail and the moderator page. */
export function evidenceLine(e: Evidence): string {
  switch (e.kind) {
    case "satellite":
      return `${e.title} (satellite, ${fmtDay(e.date)}, ${km(e.distanceM)} away)`;
    case "fire_hotspot":
      return `a fire seen by satellite on ${fmtDay(e.date)}, ${km(e.distanceM)} away`;
    case "linked_detection":
      return `the satellite detection the reporter pointed to, ${km(e.distanceM)} away`;
    case "heavy_rain":
      return `heavy rain over the district on ${fmtDay(e.date)} (${Math.round(e.rainMm)} mm)`;
    case "other_reports":
      return e.count === 1 ? `another person's report of the same, ${km(e.nearestM)} away` : `${e.count} other people's reports of the same, the nearest ${km(e.nearestM)} away`;
  }
}

/** The note on the public case trail when a report is confirmed automatically. No personal detail goes in it. */
export function publicNote(review: AutoReview, f: Pick<ReviewFacts, "photo">): string {
  const parts: string[] = [];
  if (review.reasons.includes("photo_matches") && review.photoDistanceM != null && f.photo?.takenAt) {
    parts.push(`the photo's own GPS position is ${km(review.photoDistanceM)} from this spot and it was taken on ${fmtDay(f.photo.takenAt)}`);
  }
  if (review.reasons.includes("corroborated")) parts.push(`it matches ${review.evidence.slice(0, 3).map(evidenceLine).join("; ")}`);
  if (review.reasons.includes("on_site")) parts.push("it was sent from the spot with the phone's own location, with a photo taken that day or the day before");
  return `Checked automatically: ${parts.join("; and ")}.`;
}

const REJECT_NOTES: Partial<Record<ReviewReason, string>> = {
  unsafe_photo: "The photo failed the automatic safety screen and has been deleted.",
  duplicate: "The same photo was already sent for this place.",
  photo_reused: "The same photo was already used for a report of a different place.",
  photo_outside_ghana: "The photo's own GPS position is outside Ghana.",
  photo_far: "The photo's own GPS position is more than 50 km from the reported spot.",
  photo_old: "The photo was taken more than a year before the report.",
  no_evidence: "Nothing confirmed this report within 30 days: no photo location, no matching satellite evidence and no other reports.",
};

/** The moderation note recorded with an automatic decision (seen by moderators). */
export function moderationNote(review: AutoReview, f: Pick<ReviewFacts, "photo">): string {
  if (review.decision === "approve") return publicNote(review, f);
  return review.reasons.map((r) => REJECT_NOTES[r] ?? r).join(" ");
}
