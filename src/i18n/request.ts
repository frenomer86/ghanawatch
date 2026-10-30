import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

/**
 * Twi messages are a partial draft; anything missing falls back to English so
 * the interface never shows a bare key.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const en = (await import("../../messages/en.json")).default;
  const messages = locale === "en" ? en : deepMerge(en, (await import(`../../messages/${locale}.json`)).default);
  return {
    locale,
    messages,
    timeZone: "Africa/Accra",
    formats: {
      dateTime: {
        day: { day: "numeric", month: "short", year: "numeric" },
        dayLong: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
        dayTime: { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
      },
      number: {
        ha: { maximumFractionDigits: 1 },
        integer: { maximumFractionDigits: 0 },
      },
    },
  };
});

type Tree = { [k: string]: string | Tree };

function deepMerge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith("_")) continue;
    const b = base[k];
    out[k] = typeof v === "object" && v && typeof b === "object" && b ? deepMerge(b, v) : v;
  }
  return out;
}
