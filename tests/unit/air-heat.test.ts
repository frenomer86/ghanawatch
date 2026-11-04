import { describe, expect, it } from "vitest";
import { aqiLevel, dailyAir, dailyHeat, heatLevel } from "@/lib/domain/air-heat";

/** Air quality and heat levels, and the reduction of Open-Meteo's hourly output to one value per district-day. */
const hours = (day: string, n = 24) => Array.from({ length: n }, (_, h) => `${day}T${String(h).padStart(2, "0")}:00`);

describe("air quality", () => {
  it("uses the US AQI breakpoints", () => {
    expect([0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301, 500].map(aqiLevel)).toEqual([
      "good", "good", "moderate", "moderate", "sensitive", "sensitive", "unhealthy", "unhealthy", "veryUnhealthy", "veryUnhealthy", "hazardous", "hazardous",
    ]);
    expect(aqiLevel(null)).toBeNull();
  });

  it("takes the 24-hour mean of PM2.5 and PM10 and the worst hour of dust and AQI, skipping missing hours and short days", () => {
    const time = [...hours("2026-12-10"), ...hours("2026-12-11", 6)];
    const pm25: Array<number | null> = time.map((_, i) => (i < 24 ? (i % 2 ? 30 : 10) : 99));
    pm25[3] = null;
    const days = dailyAir({ time, pm2_5: pm25, pm10: time.map(() => 80), dust: time.map((_, i) => (i === 14 ? 412 : 20)), us_aqi: time.map((_, i) => (i === 15 ? 168 : 60)) });
    expect(days).toHaveLength(1);
    expect(days[0]).toEqual({ day: "2026-12-10", pm25: 19.6, pm10: 80, dust: 412, aqi: 168 });
  });
});

describe("heat", () => {
  it("uses the heat-index categories on the feels-like temperature", () => {
    expect([25, 27, 31.9, 32, 40.9, 41, 53.9, 54].map((t) => heatLevel(t))).toEqual(["none", "caution", "caution", "extremeCaution", "extremeCaution", "danger", "danger", "extremeDanger"]);
  });

  it("raises the level to danger at a wet-bulb temperature of 28 °C and to the top at 31 °C", () => {
    expect(heatLevel(33, 27.9)).toBe("extremeCaution");
    expect(heatLevel(33, 28)).toBe("danger");
    expect(heatLevel(44, 28.5)).toBe("extremeDanger");
    expect(heatLevel(30, 31)).toBe("extremeDanger");
  });

  it("reads the daily maxima and the worst hour of wet-bulb temperature", () => {
    const time = [...hours("2027-03-02"), ...hours("2027-03-03")];
    const days = dailyHeat({
      daily: { time: ["2027-03-02", "2027-03-03"], temperature_2m_max: [38.46, null], apparent_temperature_max: [43.04, 41.6] },
      hourly: { time, wet_bulb_temperature_2m: time.map((_, i) => (i === 13 ? 26.44 : i === 37 ? 28.2 : 20)) },
    });
    expect(days).toEqual([
      { day: "2027-03-02", tempMaxC: 38.5, feelsLikeMaxC: 43, wetBulbMaxC: 26.4 },
      { day: "2027-03-03", tempMaxC: null, feelsLikeMaxC: 41.6, wetBulbMaxC: 28.2 },
    ]);
  });
});
