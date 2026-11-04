/**
 * Air quality and heat stress for every district: the levels, their meaning and the advice that goes with
 * them, and the reduction of hourly model output to one value per district and day. Pure; the pipeline
 * adapter (src/pipeline/adapters/air-heat.ts) fetches the data and the Air and heat page shows it.
 *
 * Air: the US EPA Air Quality Index (the scale Open-Meteo reports, from CAMS global forecasts of PM2.5,
 * PM10 and dust), highest hour of the day. Ghana's EPA uses the same breakpoints for its AQI reporting.
 * Heat: the US National Weather Service heat-index categories applied to the day's highest apparent
 * (feels-like) temperature, raised to at least "danger" when the wet-bulb temperature reaches 28 °C, above
 * which heavy outdoor work is dangerous even in shade, and to the top level at 31 °C.
 */

export const AQI_LEVELS = ["good", "moderate", "sensitive", "unhealthy", "veryUnhealthy", "hazardous"] as const;
export type AqiLevel = (typeof AQI_LEVELS)[number];

export function aqiLevel(aqi: number | null | undefined): AqiLevel | null {
  if (aqi == null || !Number.isFinite(aqi)) return null;
  return aqi <= 50 ? "good" : aqi <= 100 ? "moderate" : aqi <= 150 ? "sensitive" : aqi <= 200 ? "unhealthy" : aqi <= 300 ? "veryUnhealthy" : "hazardous";
}

export const AQI_TEXT: Record<AqiLevel, { label: string; advice: string }> = {
  good: { label: "Good", advice: "Air quality is fine for everyone." },
  moderate: { label: "Moderate", advice: "Acceptable. People unusually sensitive to dust or smoke should limit long, hard effort outdoors." },
  sensitive: {
    label: "Unhealthy for sensitive groups",
    advice: "Children, older people, pregnant women and people with asthma or heart or lung disease should cut down long or hard effort outdoors.",
  },
  unhealthy: { label: "Unhealthy", advice: "Everyone should cut down long or hard effort outdoors; sensitive groups should avoid it. Keep windows closed during dust or smoke." },
  veryUnhealthy: { label: "Very unhealthy", advice: "Everyone should avoid long or hard effort outdoors. Sensitive groups should stay indoors. Wear a well-fitting mask outside." },
  hazardous: { label: "Hazardous", advice: "Everyone should stay indoors with windows closed and avoid all outdoor effort. Seek care for breathing difficulty." },
};

export const HEAT_LEVELS = ["none", "caution", "extremeCaution", "danger", "extremeDanger"] as const;
export type HeatLevel = (typeof HEAT_LEVELS)[number];

export function heatLevel(feelsLikeC: number | null | undefined, wetBulbC?: number | null): HeatLevel | null {
  if (feelsLikeC == null || !Number.isFinite(feelsLikeC)) return null;
  let i = feelsLikeC >= 54 ? 4 : feelsLikeC >= 41 ? 3 : feelsLikeC >= 32 ? 2 : feelsLikeC >= 27 ? 1 : 0;
  if (wetBulbC != null && wetBulbC >= 31) i = 4;
  else if (wetBulbC != null && wetBulbC >= 28) i = Math.min(4, Math.max(i + 1, 3));
  return HEAT_LEVELS[i];
}

export const HEAT_TEXT: Record<HeatLevel, { label: string; advice: string }> = {
  none: { label: "No heat stress", advice: "" },
  caution: { label: "Caution", advice: "Fatigue is possible with long exposure and activity. Drink water regularly." },
  extremeCaution: {
    label: "Extreme caution",
    advice: "Heat cramps and heat exhaustion are possible. Drink water often, rest in shade, and avoid hard work in the middle of the day.",
  },
  danger: {
    label: "Danger",
    advice: "Heat exhaustion is likely and heat stroke possible with long exposure. Move outdoor work to early morning or evening, rest often in shade, check on older people and young children.",
  },
  extremeDanger: { label: "Extreme danger", advice: "Heat stroke is highly likely. Stop hard outdoor work, stay in the coolest place available, and get help quickly for anyone confused or not sweating." },
};

/** One district-day of air quality. */
export interface AirDay {
  day: string;
  /** 24-hour mean PM2.5, µg/m³. */
  pm25: number | null;
  /** 24-hour mean PM10, µg/m³. */
  pm10: number | null;
  /** Highest hourly Saharan dust concentration, µg/m³. */
  dust: number | null;
  /** Highest hourly US AQI. */
  aqi: number | null;
}

/** One district-day of heat. */
export interface HeatDay {
  day: string;
  tempMaxC: number | null;
  feelsLikeMaxC: number | null;
  wetBulbMaxC: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const nums = (xs: Array<number | null | undefined>) => xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

/** Group hourly values (local times "YYYY-MM-DDTHH:MM") by day, keeping days with at least 18 hours. */
function byDay(time: string[], cols: Record<string, Array<number | null | undefined> | undefined>): Map<string, Record<string, number[]>> {
  const out = new Map<string, Record<string, number[]>>();
  time.forEach((t, i) => {
    const day = t.slice(0, 10);
    let rec = out.get(day);
    if (!rec) out.set(day, (rec = Object.fromEntries(Object.keys(cols).map((k) => [k, [] as number[]]))));
    for (const [k, v] of Object.entries(cols)) {
      const x = v?.[i];
      if (typeof x === "number" && Number.isFinite(x)) rec[k].push(x);
    }
  });
  const counts = new Map<string, number>();
  for (const t of time) counts.set(t.slice(0, 10), (counts.get(t.slice(0, 10)) ?? 0) + 1);
  for (const [day, n] of counts) if (n < 18) out.delete(day);
  return out;
}

export function dailyAir(h: { time: string[]; pm2_5?: Array<number | null>; pm10?: Array<number | null>; dust?: Array<number | null>; us_aqi?: Array<number | null> }): AirDay[] {
  const days = byDay(h.time, { pm25: h.pm2_5, pm10: h.pm10, dust: h.dust, aqi: h.us_aqi });
  return [...days].map(([day, r]) => {
    const pm25 = mean(r.pm25);
    const pm10 = mean(r.pm10);
    const dust = max(r.dust);
    const aqi = max(r.aqi);
    return { day, pm25: pm25 == null ? null : round1(pm25), pm10: pm10 == null ? null : round1(pm10), dust: dust == null ? null : Math.round(dust), aqi: aqi == null ? null : Math.round(aqi) };
  });
}

export function dailyHeat(r: {
  daily: { time: string[]; temperature_2m_max?: Array<number | null>; apparent_temperature_max?: Array<number | null> };
  hourly?: { time: string[]; wet_bulb_temperature_2m?: Array<number | null> };
}): HeatDay[] {
  const wb = r.hourly ? byDay(r.hourly.time, { wb: r.hourly.wet_bulb_temperature_2m }) : new Map<string, Record<string, number[]>>();
  return r.daily.time.map((day, i) => {
    const t = nums([r.daily.temperature_2m_max?.[i]])[0];
    const a = nums([r.daily.apparent_temperature_max?.[i]])[0];
    const w = max(wb.get(day)?.wb ?? []);
    return { day, tempMaxC: t == null ? null : round1(t), feelsLikeMaxC: a == null ? null : round1(a), wetBulbMaxC: w == null ? null : round1(w) };
  });
}

/** Harmattan dust is in the air when the day's highest hourly dust concentration reaches this, µg/m³. */
export const DUST_HAZE = 100;
