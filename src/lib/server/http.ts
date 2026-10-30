import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { env } from "./env";
import { searchParamsToObject } from "@/lib/domain/validation";

/**
 * Shared plumbing for /api/v1 route handlers: validation, uniform errors,
 * cache headers, rate limiting and hashed client identifiers.
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "no-store",
};

export function json<T>(data: T, init: { status?: number; cache?: CachePolicy; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...baseHeaders, ...init.headers };
  if (init.cache) headers["Cache-Control"] = cacheControl(init.cache);
  return NextResponse.json(data, { status: init.status ?? 200, headers });
}

export type CachePolicy = "none" | "short" | "medium" | "long";
function cacheControl(p: CachePolicy): string {
  switch (p) {
    case "short":
      return "public, max-age=60, s-maxage=300, stale-while-revalidate=900";
    case "medium":
      return "public, max-age=300, s-maxage=1800, stale-while-revalidate=3600";
    case "long":
      return "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";
    default:
      return "no-store";
  }
}

export function error(status: number, message: string, details?: unknown) {
  const headers: Record<string, string> = { ...baseHeaders };
  const retry = (details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  if ((status === 429 || status === 503) && typeof retry === "number") headers["Retry-After"] = String(Math.max(1, Math.ceil(retry)));
  return NextResponse.json({ error: statusText(status), message, ...(details !== undefined ? { details } : {}) }, { status, headers });
}

function statusText(s: number) {
  return (
    {
      400: "bad_request",
      401: "unauthorized",
      403: "forbidden",
      404: "not_found",
      409: "conflict",
      413: "payload_too_large",
      415: "unsupported_media_type",
      422: "unprocessable",
      429: "too_many_requests",
      503: "service_unavailable",
    }[s] ?? "error"
  );
}

/** Parse and validate query parameters with a Zod schema; throws HttpError(400). */
export function parseQuery<T>(req: NextRequest, schema: ZodType<T>): T {
  const result = schema.safeParse(searchParamsToObject(req.nextUrl.searchParams));
  if (!result.success) throw new HttpError(400, "Invalid query parameters", flatten(result.error));
  return result.data;
}

/**
 * Read a request body of at most `maxBytes`, stopping as soon as the limit is passed rather than
 * buffering everything first; a chunked request with no Content-Length gets the same ceiling.
 */
export async function readBody(req: Pick<Request, "headers" | "body">, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpError(413, `Body larger than ${maxBytes} bytes`);
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, `Body larger than ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Parse a JSON body (≤ 64 KB) with a Zod schema; throws HttpError(400/413/415). */
export async function parseJson<T>(req: NextRequest, schema: ZodType<T>, maxBytes = 64 * 1024): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Expected application/json");
  const text = new TextDecoder().decode(await readBody(req, maxBytes));
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new HttpError(400, "Invalid request body", flatten(result.error));
  return result.data;
}

function flatten(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Wrap a handler so thrown HttpError/ZodError become JSON responses and nothing else leaks. */
export function handle(fn: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      // Next.js signals "render this at request time" by throwing; it must propagate untouched.
      if (typeof (e as { digest?: unknown })?.digest === "string" && String((e as { digest: string }).digest).startsWith("NEXT_")) throw e;
      if (e instanceof HttpError) return error(e.status, e.message, e.details);
      if (e instanceof ZodError) return error(400, "Validation failed", flatten(e));
      console.error("[api]", req.nextUrl.pathname, e);
      return error(500, "Internal error");
    }
  };
}

/** Client IP, hashed with the app secret so logs never hold raw addresses. */
export function clientIpHash(req: Request): string {
  // The proxy in front of the app (Caddy) adds the caller's address last; earlier entries come from the
  // caller and can be forged to dodge rate limits, so only the last one counts.
  const fwd = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ip = ipBucket(fwd || req.headers.get("x-real-ip") || "unknown");
  return createHash("sha256").update(`${env().APP_SECRET}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * The unit a caller is counted by. An IPv4 address is one caller. An IPv6 host is normally given a whole
 * /64 (18 quintillion addresses), so counting single IPv6 addresses would let anyone on a cheap server
 * start every request from a fresh address and never meet a rate limit: IPv6 callers are counted per /64.
 * IPv4-mapped IPv6 (::ffff:1.2.3.4) counts as the IPv4 address, and a port or zone suffix is dropped.
 */
export function ipBucket(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

/** The eight hextets of an IPv6 address (leading zeros dropped), or null when it is not one. */
export function expandIpv6(ip: string): string[] | null {
  let s = ip;
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${s.slice(0, -v4[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => g.replace(/^0+(?=.)/, ""));
}

// ---------------------------------------------------------------------------
// Rate limiting: fixed window per key, in-memory. One process per instance is
// fine for the MVP; swap for Redis (same interface) when running more than one.
// ---------------------------------------------------------------------------
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
/** Above this many live keys the oldest are dropped, so a flood of distinct callers cannot grow memory without end. */
const MAX_BUCKETS = 100_000;

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.delete(key);
    buckets.set(key, b);
    if (buckets.size > MAX_BUCKETS / 2) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    // Still too many: drop the oldest windows first (a Map iterates in insertion order).
    for (const k of buckets.keys()) {
      if (buckets.size <= MAX_BUCKETS) break;
      buckets.delete(k);
    }
  }
  b.count++;
  return { ok: b.count <= limit, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
}

export function enforceRateLimit(req: NextRequest, scope: "public" | "reports" | "sightings" | "login" | "heavy") {
  const e = env();
  const cfg = {
    public: { limit: e.RATE_LIMIT_PUBLIC_PER_MIN, windowMs: 60_000 },
    heavy: { limit: e.RATE_LIMIT_HEAVY_PER_MIN, windowMs: 60_000 },
    reports: { limit: e.RATE_LIMIT_REPORTS_PER_HOUR, windowMs: 3_600_000 },
    sightings: { limit: e.RATE_LIMIT_SIGHTINGS_PER_HOUR, windowMs: 3_600_000 },
    login: { limit: e.RATE_LIMIT_LOGIN_PER_MIN, windowMs: 60_000 },
  }[scope];
  const r = rateLimit(`${scope}:${clientIpHash(req)}`, cfg.limit, cfg.windowMs);
  if (!r.ok) {
    throw new HttpError(429, "Too many requests", { retryAfterSeconds: r.retryAfterSec });
  }
}

// ---------------------------------------------------------------------------
// Expensive work (satellite reads, stitched images, PDFs) runs through one
// bounded queue per process: a few jobs at a time, a short waiting line, and
// 503 with Retry-After for everyone else rather than an ever-growing backlog
// that pins the event loop and hammers upstream providers.
// ---------------------------------------------------------------------------
const HEAVY_CONCURRENCY = 3;
const HEAVY_QUEUE = 12;
let heavyActive = 0;
let heavyWaiting = 0;
const heavyQueue: Array<() => void> = [];

export async function heavyWork<T>(fn: () => Promise<T>): Promise<T> {
  if (heavyActive >= HEAVY_CONCURRENCY) {
    if (heavyWaiting >= HEAVY_QUEUE) throw new HttpError(503, "The server is busy with other checks; try again in a moment", { retryAfterSeconds: 20 });
    heavyWaiting++;
    await new Promise<void>((resolve) => heavyQueue.push(resolve));
    heavyWaiting--;
  }
  heavyActive++;
  try {
    return await fn();
  } finally {
    heavyActive--;
    heavyQueue.shift()?.();
  }
}

/** Reject cross-site state-changing requests (defence in depth next to SameSite cookies). */
export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  const expected = new URL(env().PUBLIC_ORIGIN).origin;
  const host = req.headers.get("host");
  if (origin && origin !== expected && origin !== `${req.nextUrl.protocol}//${host}`) {
    throw new HttpError(403, "Cross-origin request rejected");
  }
}
