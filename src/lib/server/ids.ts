import { createHash, randomBytes } from "node:crypto";

/**
 * UUID v7: 48-bit Unix millisecond timestamp followed by random bits.
 * Time-ordered ids keep B-tree inserts append-only and make "newest first"
 * cheap without exposing sequential counters.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(now);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic UUID v5-like id from a namespace and name, for stable seed/reference rows. */
export function stableId(namespace: string, name: string): string {
  // SHA-256 based; good enough for stable reference ids, not a real v5 (which uses SHA-1).
  const h = createHash("sha256").update(`${namespace}:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80; // mark as version 8 (custom)
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
