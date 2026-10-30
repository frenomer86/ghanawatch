import type { Locale, Severity } from "./types";

/** Formatting helpers that work in both server and client components. */

const TZ = "Africa/Accra";

export function formatDay(iso: string | Date, locale: Locale = "en"): string {
  const d = typeof iso === "string" ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso) : iso;
  return new Intl.DateTimeFormat(locale === "tw" ? "en-GH" : "en-GH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TZ,
  }).format(d);
}

export function formatDayTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-GH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  }).format(d);
}

export function formatRelative(iso: string | Date, now: Date = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(diffMin) < 60) return rtf.format(-diffMin, "minute");
  const diffH = Math.round(diffMin / 60);
  if (Math.abs(diffH) < 48) return rtf.format(-diffH, "hour");
  return rtf.format(-Math.round(diffH / 24), "day");
}

export function formatHectares(ha: number | null | undefined): string {
  if (ha == null) return "–";
  if (ha < 1) return `${ha.toFixed(2)} ha`;
  if (ha < 100) return `${ha.toFixed(1)} ha`;
  return `${Math.round(ha).toLocaleString("en-GH")} ha`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-GH");
}

export const severityOrder: Record<Severity, number> = { normal: 0, watch: 1, elevated: 2, urgent: 3 };

export function maxSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((m, s) => (severityOrder[s] > severityOrder[m] ? s : m), "normal");
}

export function hoursAgo(h: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - h * 3_600_000);
}
