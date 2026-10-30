import { env } from "@/lib/server/env";

/**
 * Outbound HTTP for Ground view lookups: a timeout on every call, an
 * identifying User-Agent (Wikimedia and others require one) and no retries,
 * because a slow provider should leave its panel empty rather than hold the
 * whole response.
 */
export function userAgent() {
  return `GhanaWatch/1.0 (+${env().PUBLIC_ORIGIN})`;
}

export async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 10_000, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { "user-agent": userAgent(), accept: "application/json", ...(headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** True for https URLs whose host is a public name, not an IP literal or a local name. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return false;
  // IPv4 or IPv6 literals.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return false;
  return true;
}
