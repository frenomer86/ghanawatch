import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { clientIpHash, expandIpv6, HttpError, ipBucket, rateLimit, readBody } from "@/lib/server/http";
import { Semaphore } from "@/lib/server/explore/cache";

/** Security review, 30 October 2026: rate-limit identity, body ceilings, bounded queues. */

const req = (xff: string) => new NextRequest("http://localhost/api/v1/x", { headers: { "x-forwarded-for": xff } });

describe("rate-limit identity (ipBucket / clientIpHash)", () => {
  it("counts an IPv4 caller by its address, dropping a port", () => {
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("203.0.113.9:51234")).toBe("203.0.113.9");
    expect(ipBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("counts an IPv6 caller by its /64, whatever the spelling", () => {
    const a = ipBucket("2a02:4780:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2a02:4780:1:2::/64");
    expect(ipBucket("[2a02:4780:0001:0002::1]:443")).toBe(a);
    expect(ipBucket("2A02:4780:1:2::ffff")).toBe(a);
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipBucket("2a02:4780:1:3::1")).not.toBe(a);
  });

  it("expands IPv6 forms and refuses malformed ones", () => {
    expect(expandIpv6("::1")).toEqual(["0", "0", "0", "0", "0", "0", "0", "1"]);
    expect(expandIpv6("64:ff9b::192.0.2.33")).toEqual(["64", "ff9b", "0", "0", "0", "0", "c000", "221"]);
    expect(expandIpv6("1::2::3")).toBeNull();
    expect(expandIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(expandIpv6("12345::1")).toBeNull();
  });

  it("gives every address of one /64 the same hash, so rotating addresses does not reset a limit", () => {
    const h1 = clientIpHash(req("2a02:4780:1:2::10"));
    const h2 = clientIpHash(req("2a02:4780:1:2:dead:beef:0:1"));
    const other = clientIpHash(req("2a02:4780:1:99::10"));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(other);
  });

  it("still trusts only the last X-Forwarded-For entry (the one the proxy adds)", () => {
    expect(clientIpHash(req("1.1.1.1, 198.51.100.7"))).toBe(clientIpHash(req("9.9.9.9, 198.51.100.7")));
    expect(clientIpHash(req("198.51.100.7, 1.1.1.1"))).not.toBe(clientIpHash(req("198.51.100.7, 9.9.9.9")));
  });

  it("rate limits per key and window", () => {
    const key = `test-${Math.random()}`;
    const results = Array.from({ length: 4 }, () => rateLimit(key, 3, 60_000).ok);
    expect(results).toEqual([true, true, true, false]);
  });
});

describe("readBody ceiling", () => {
  it("refuses a declared length over the limit before reading", async () => {
    const r = new Request("http://localhost/x", { method: "POST", body: "x".repeat(10), headers: { "content-length": "999999" } });
    await expect(readBody(r, 100)).rejects.toMatchObject({ status: 413 });
  });

  it("stops a streamed body with no length as soon as it passes the limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 1000) c.close();
      },
    });
    const r = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readBody(r, 4096)).rejects.toBeInstanceOf(HttpError);
    expect(pulled).toBeLessThan(20);
  });

  it("reads a small body whole", async () => {
    const r = new Request("http://localhost/x", { method: "POST", body: "token=abc" });
    expect(new TextDecoder().decode(await readBody(r, 4096))).toBe("token=abc");
  });
});

describe("Semaphore with a bounded waiting line", () => {
  it("turns callers away once the line is full instead of queueing without end", async () => {
    const s = new Semaphore(1, 2, () => new HttpError(503, "busy"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = s.run(() => gate);
    const waiting = [s.run(async () => 1), s.run(async () => 2)];
    await expect(s.run(async () => 3)).rejects.toMatchObject({ status: 503 });
    release();
    await running;
    expect(await Promise.all(waiting)).toEqual([1, 2]);
  });
});
