import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/domain/types";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // English lives at /, Twi at /tw. Shared links stay short and stable.
  localePrefix: "as-needed",
  localeCookie: {
    name: "gw_locale",
    maxAge: 60 * 60 * 24 * 365,
  },
});
