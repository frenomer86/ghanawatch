import type { Authority, CaseStatus, ChangeType, ReportCategory, ReportStatus, SatelliteVerdict } from "./types";

/**
 * Public shape of a citizen report and its case trail. Shared by the API, the
 * public case pages and the admin page. Reporters are never identified: no
 * name or account is collected, photos lose their location data, and public
 * coordinates are rounded to about 100 m.
 */
export interface SatelliteCheck {
  checkedAt: string;
  radiusM: number;
  suggestion: Exclude<SatelliteVerdict, "under_review">;
  detections: Array<{ id: string; type: ChangeType; title: string; severity: string; imageDate: string; distanceM: number }>;
  closeUp: { capturedOn: string | null; sensor: string | null; resolutionM: number | null; release: number } | null;
}

export interface CaseEvent {
  status: CaseStatus;
  authority: Authority | null;
  note: string | null;
  at: string;
}

export interface PublicCase {
  id: string;
  category: ReportCategory;
  description: string;
  createdAt: string;
  lat: number;
  lon: number;
  districtName: string | null;
  regionName: string | null;
  status: ReportStatus;
  caseStatus: CaseStatus;
  satelliteVerdict: SatelliteVerdict;
  authority: Authority | null;
  photoUrl: string | null;
  satelliteCheck: SatelliteCheck | null;
  timeline: CaseEvent[];
}

/** What anyone holding the link sees before a moderator has approved the report. */
export interface PendingCase {
  id: string;
  status: Exclude<ReportStatus, "approved">;
  createdAt: string;
}

/** About 100 m: enough to find the site, not the spot a reporter stood on. */
export const roundPublic = (v: number) => Number(v.toFixed(3));
