import { MAX_CLOSEUP_RES_M, type HighResCapture } from "@/lib/explore/imagery";
import { TtlCache, roundCoord } from "./cache";
import { getJson } from "./fetch";

/**
 * Esri World Imagery Wayback: every published release of World Imagery since
 * 2014, each with a metadata layer saying which satellite captured the image
 * at a point, when, and at what resolution. Used to list the distinct
 * high-resolution captures available for a spot, newest first.
 */
const CONFIG_URL = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

interface Release {
  release: number;
  date: string | null;
  metadataUrl: string;
}

interface ConfigEntry {
  itemTitle?: string;
  metadataLayerUrl?: string;
}

const configCache = new TtlCache<Release[]>(1, 24 * 3_600_000);
const captureCache = new TtlCache<HighResCapture[]>(500, 12 * 3_600_000);

export function parseConfig(json: Record<string, ConfigEntry>): Release[] {
  const out: Release[] = [];
  for (const [key, v] of Object.entries(json)) {
    const release = Number(key);
    if (!Number.isInteger(release) || !v.metadataLayerUrl?.startsWith("https://")) continue;
    const date = v.itemTitle?.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    out.push({ release, date, metadataUrl: v.metadataLayerUrl });
  }
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

async function releases(): Promise<Release[]> {
  return configCache.get("config", async () => parseConfig(await getJson<Record<string, ConfigEntry>>(CONFIG_URL)));
}

/**
 * Releases worth probing: the newest, the newest of every earlier year, and the
 * very first. A capture that persisted to the end of any year is found.
 */
export function probeSet(all: Release[]): Release[] {
  if (!all.length) return [];
  const picked = new Map<number, Release>();
  picked.set(all[0].release, all[0]);
  const seenYears = new Set<string>();
  for (const r of all) {
    const y = r.date?.slice(0, 4);
    if (!y || seenYears.has(y)) continue;
    seenYears.add(y);
    picked.set(r.release, r);
  }
  const first = all[all.length - 1];
  picked.set(first.release, first);
  return [...picked.values()];
}

const SENSORS: Record<string, string> = {
  WV01: "WorldView-1",
  WV02: "WorldView-2",
  WV03: "WorldView-3",
  WV04: "WorldView-4",
  GE01: "GeoEye-1",
  QB02: "QuickBird-2",
  IK02: "IKONOS",
  PHR1A: "Pléiades 1A",
  PHR1B: "Pléiades 1B",
};

/** 20221221, "20221221" or "12/21/2022" to 2022-12-21. */
export function parseSrcDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

interface IdentifyResult {
  layerId: number;
  attributes?: Record<string, string | number | null>;
}

export function pickFinest(results: IdentifyResult[]): Omit<HighResCapture, "release" | "releaseDate"> | null {
  const withDate = results.filter((r) => r.attributes && (r.attributes.SRC_DATE != null || r.attributes.SRC_DATE2 != null));
  if (!withDate.length) return null;
  const best = withDate.reduce((a, b) => (b.layerId < a.layerId ? b : a));
  const a = best.attributes!;
  const sensorCode = a.SRC_DESC != null ? String(a.SRC_DESC) : null;
  const res = Number(a.SRC_RES);
  const maxLevel = Number(a.MaxMapLevel);
  return {
    capturedOn: parseSrcDate(a.SRC_DATE) ?? parseSrcDate(a.SRC_DATE2),
    provider: a.NICE_DESC != null ? String(a.NICE_DESC) : null,
    sensor: sensorCode ? (SENSORS[sensorCode] ?? sensorCode) : null,
    resolutionM: Number.isFinite(res) && res > 0 ? res : null,
    maxLevel: Number.isInteger(maxLevel) && maxLevel > 0 ? maxLevel : null,
  };
}

async function identify(r: Release, lon: number, lat: number) {
  const d = 0.0005;
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: "all",
    tolerance: "0",
    mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`,
    imageDisplay: "256,256,96",
    returnGeometry: "false",
    f: "json",
  });
  const json = await getJson<{ results?: IdentifyResult[] }>(`${r.metadataUrl}/identify?${params}`, { timeoutMs: 8_000 });
  return pickFinest(json.results ?? []);
}

/** Distinct high-resolution captures at a point, newest first. */
export async function highResCaptures(lon: number, lat: number): Promise<HighResCapture[]> {
  const key = `${roundCoord(lon)},${roundCoord(lat)}`;
  return captureCache.get(key, async () => {
    const probes = probeSet(await releases());
    const found = await Promise.all(
      probes.map(async (r) => {
        // One retry: a dropped answer would silently remove a capture from the list.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const c = await identify(r, lon, lat);
            return c ? { ...c, release: r.release, releaseDate: r.date } : null;
          } catch {
            /* try again once */
          }
        }
        return null;
      }),
    );
    const out: HighResCapture[] = [];
    const seen = new Set<string>();
    // probes are newest release first, so each capture keeps the newest release that shows it.
    for (const c of found) {
      if (!c || (c.resolutionM != null && c.resolutionM > MAX_CLOSEUP_RES_M)) continue;
      const k = `${c.capturedOn}|${c.sensor}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    if (!out.length && probes.length) {
      // No metadata answered; still offer the newest release without a date rather than nothing.
      out.push({ release: probes[0].release, releaseDate: probes[0].date, capturedOn: null, provider: null, sensor: null, resolutionM: null, maxLevel: null });
    }
    return out.sort((a, b) => (b.capturedOn ?? "").localeCompare(a.capturedOn ?? ""));
  });
}
