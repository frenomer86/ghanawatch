import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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

/**
 * Addresses a server-side fetch must never reach: this machine, private and carrier-grade NAT networks,
 * link-local (cloud metadata at 169.254.169.254), multicast, reserved and documentation ranges, and their
 * IPv6 equivalents (unique-local, link-local, NAT64 and IPv4-mapped forms).
 */
const NON_PUBLIC = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    b.addSubnet(net, bits, "ipv4");
  for (const [net, bits] of [
    // Unspecified, loopback and the old IPv4-compatible form. (IPv4-mapped addresses are unwrapped and
    // checked as IPv4 below; a ::ffff:0:0/96 rule here would also match every plain IPv4 address.)
    ["::", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const)
    b.addSubnet(net, bits, "ipv6");
  return b;
})();

/** True for a literal IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC.check(address, "ipv4");
  if (family !== 6) return false;
  // The URL parser writes any IPv6 address in one canonical form, IPv4-mapped ones as ::ffff:hhhh:hhhh.
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return false; // a zone suffix (fe80::1%eth0) or anything else the parser refuses
  }
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !NON_PUBLIC.check(canonical, "ipv6");
}

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true });

/**
 * True when the URL passes isPublicHttpsUrl and every address its host resolves to is public. A name that
 * a third party controls (a photo host listed by a federated catalogue, say) can point at 127.0.0.1 or the
 * cloud metadata address; this check runs before each request and each redirect hop.
 */
export async function resolvesToPublic(raw: string, resolve: Lookup = systemLookup): Promise<boolean> {
  if (!isPublicHttpsUrl(raw)) return false;
  try {
    const addrs = await resolve(new URL(raw).hostname);
    return addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
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
