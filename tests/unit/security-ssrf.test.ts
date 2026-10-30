import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isPublicAddress, resolvesToPublic } from "@/lib/server/explore/fetch";
import { depositOnZenodo, sameHttpsHost } from "@/lib/server/release/zenodo";

/** Security review, 30 October 2026: server-side requests to addresses a third party chooses. */

const lookupResult = vi.hoisted(() => ({ addrs: [{ address: "93.184.216.34", family: 4 }] as Array<{ address: string; family: number }> }));
vi.mock("node:dns/promises", () => ({ lookup: async () => lookupResult.addrs }));
vi.mock("@/lib/server/explore/ground", () => ({ resolveStreetPhoto: async () => "https://photos.panoramax-instance.example/pic.jpg" }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  lookupResult.addrs = [{ address: "93.184.216.34", family: 4 }];
});

describe("isPublicAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "not-an-ip"])(
    "refuses %s",
    (a) => expect(isPublicAddress(a)).toBe(false),
  );
  it.each(["93.184.216.34", "1.1.1.1", "2a00:1450:4001:80b::200e", "::ffff:93.184.216.34"])("accepts %s", (a) => expect(isPublicAddress(a)).toBe(true));
});

describe("resolvesToPublic", () => {
  const resolveTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  it("accepts a name that resolves only to public addresses", async () => {
    expect(await resolvesToPublic("https://cdn.example.org/a.jpg", resolveTo("93.184.216.34", "2a00:1450:4001:80b::200e"))).toBe(true);
  });
  it("refuses a public-looking name that resolves to a private or metadata address", async () => {
    expect(await resolvesToPublic("https://evil.example.org/a.jpg", resolveTo("169.254.169.254"))).toBe(false);
    expect(await resolvesToPublic("https://evil.example.org/a.jpg", resolveTo("93.184.216.34", "127.0.0.1"))).toBe(false);
  });
  it("refuses http, IP literals, local names and failed lookups", async () => {
    expect(await resolvesToPublic("http://cdn.example.org/a.jpg", resolveTo("93.184.216.34"))).toBe(false);
    expect(await resolvesToPublic("https://10.0.0.1/a.jpg", resolveTo("10.0.0.1"))).toBe(false);
    expect(await resolvesToPublic("https://localhost/a.jpg", resolveTo("127.0.0.1"))).toBe(false);
    expect(
      await resolvesToPublic("https://gone.example.org/a.jpg", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe(false);
  });
});

describe("GET /api/v1/explore/photo", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/v1/explore/photo/route");
    return GET(new NextRequest("http://localhost/api/v1/explore/photo?src=panoramax&id=abcdef123"), { params: Promise.resolve({}) });
  };

  it("never fetches a photo whose host resolves to an internal address", async () => {
    lookupResult.addrs = [{ address: "169.254.169.254", family: 4 }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await call();
    expect(res.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks the redirect target too", async () => {
    let n = 0;
    const fetchSpy = vi.fn(async () => {
      n++;
      lookupResult.addrs = [{ address: "10.0.0.8", family: 4 }]; // the next host is internal
      return new Response(null, { status: 302, headers: { location: "https://internal.example/" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await call();
    expect(res.status).toBe(502);
    expect(n).toBe(1);
  });

  it("passes on a public raster image with a sandboxing policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } })));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses an SVG (it would be a page with scripts on this origin)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } })));
    expect((await call()).status).toBe(502);
  });
});

describe("Zenodo deposit", () => {
  it("only sends the token to Zenodo's own host", () => {
    expect(sameHttpsHost("https://zenodo.org/api/files/abc", "https://zenodo.org/api")).toBe(true);
    expect(sameHttpsHost("https://sandbox.zenodo.org/api/files/abc", "https://sandbox.zenodo.org/api")).toBe(true);
    expect(sameHttpsHost("https://zenodo.org.evil.example/api/files/abc", "https://zenodo.org/api")).toBe(false);
    expect(sameHttpsHost("http://zenodo.org/api/files/abc", "https://zenodo.org/api")).toBe(false);
    expect(sameHttpsHost("https://user:pw@zenodo.org/x", "https://zenodo.org/api")).toBe(false);
    expect(sameHttpsHost(undefined, "https://zenodo.org/api")).toBe(false);
  });

  it("stops before uploading when the answer names another host", async () => {
    vi.stubEnv("ZENODO_TOKEN", "secret-token");
    vi.stubEnv("ZENODO_SANDBOX", "");
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return Response.json({ id: 1, links: { bucket: "https://attacker.example/steal" } }, { status: 201 });
      }),
    );
    await expect(depositOnZenodo({ dir: "/nonexistent", files: ["a.csv"], title: "t", description: "d", month: "2026-09", version: "1.0", log: () => undefined })).rejects.toThrow(/unexpected/);
    expect(seen.every((u) => u.startsWith("https://zenodo.org/"))).toBe(true);
  });
});
