import { CHANGE_TYPES, GHANA_CENTER, SEVERITIES, type ChangeType, type Severity } from "@/lib/domain/types";

export interface ViewState {
  lon: number;
  lat: number;
  zoom: number;
}

export interface MapFilters {
  hours: number;
  type: ChangeType | null;
  severity: Severity | null;
  districts: boolean;
  /** Also show low-confidence ("possible") detections, which the accuracy check could not confirm. */
  possible: boolean;
  /** Show places water has covered at some time (flood plains, wetlands). */
  floodProne: boolean;
}

export interface MapInitialState {
  view: ViewState;
  filters: MapFilters;
  eventId: string | null;
}

export const WINDOWS = [72, 24 * 7, 24 * 30, 24 * 90] as const;

export const DEFAULT_VIEW: ViewState = { lon: GHANA_CENTER.lon, lat: GHANA_CENTER.lat, zoom: 6.2 };

/** Parse URL search params into initial map state; invalid values fall back to defaults. Pure, usable on server and client. */
export function parseMapParams(sp: Record<string, string | string[] | undefined>): MapInitialState {
  const num = (k: string, min: number, max: number, d: number) => {
    const raw = sp[k];
    const v = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isFinite(v) && v >= min && v <= max ? v : d;
  };
  const str = (k: string) => {
    const raw = sp[k];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const hours = num("hours", 1, 24 * 365, 72);
  const type = str("type");
  const sev = str("sev");
  const ev = str("event");
  return {
    view: { lat: num("lat", 4, 12, DEFAULT_VIEW.lat), lon: num("lon", -4, 2, DEFAULT_VIEW.lon), zoom: num("z", 5, 16, DEFAULT_VIEW.zoom) },
    filters: {
      hours: (WINDOWS as readonly number[]).includes(hours) ? hours : 72,
      type: type && (CHANGE_TYPES as readonly string[]).includes(type) ? (type as ChangeType) : null,
      severity: sev && (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : null,
      districts: str("districts") === "1",
      possible: str("possible") === "1",
      floodProne: str("flood") === "1",
    },
    eventId: ev && /^[0-9a-f-]{36}$/i.test(ev) ? ev : null,
  };
}
