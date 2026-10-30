import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import type { Locale } from "@/lib/domain/types";
import { routing } from "./routing";

/** Narrow a route param to a supported locale or render the not-found page. */
export function resolveLocale(candidate: string): Locale {
  if (!hasLocale(routing.locales, candidate)) notFound();
  return candidate;
}
