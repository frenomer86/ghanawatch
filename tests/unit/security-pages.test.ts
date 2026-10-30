import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

// next-intl's middleware cannot be loaded outside Next's bundler; locale routing is not what is tested
// here, so it is replaced by "no rewrite" and the proxy's own headers are checked.
vi.mock("next-intl/middleware", () => ({ default: () => () => undefined }));

/** Security review, 30 October 2026: page headers, the service worker's offline copies, app icons. */

describe("proxy security headers", () => {
  const run = (url: string, cookie?: string) => proxy(new NextRequest(url, cookie ? { headers: { cookie } } : undefined));

  it("forbids framing everywhere except the embed cards", () => {
    const page = run("https://ghanawatch.example/districts");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("strict-transport-security")).toContain("max-age=63072000");
    for (const u of ["https://ghanawatch.example/embed/rankings", "https://ghanawatch.example/tw/embed/district/obuasi"]) {
      const embed = run(u);
      expect(embed.headers.get("x-frame-options")).toBeNull();
      expect(embed.headers.get("content-security-policy")).toContain("frame-ancestors *");
    }
    // A path that only mentions embed later on is not an embed.
    expect(run("https://ghanawatch.example/districts/embed/x").headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps the policy's script, object and base-uri limits", () => {
    const csp = run("https://ghanawatch.example/").headers.get("content-security-policy")!;
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/);
  });

  it("marks staff pages, and pages rendered for a signed-in user, as not for the offline copy", () => {
    expect(run("https://ghanawatch.example/admin").headers.get("x-gw-offline")).toBe("no-store");
    expect(run("https://ghanawatch.example/tw/admin/login").headers.get("x-gw-offline")).toBe("no-store");
    expect(run("https://ghanawatch.example/reports/01a00000-0000-7000-8000-000000000001", "gw_session=abc").headers.get("x-gw-offline")).toBe("no-store");
    expect(run("https://ghanawatch.example/reports/01a00000-0000-7000-8000-000000000001").headers.get("x-gw-offline")).toBeNull();
    expect(run("https://ghanawatch.example/administration-guide").headers.get("x-gw-offline")).toBeNull();
  });
});

/** Runs public/sw.js against an in-memory Cache Storage and a scripted network. */
function serviceWorker(network: (url: string) => Response) {
  const stores = new Map<string, Map<string, Response>>();
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (req: { url: string } | string) => m.get(typeof req === "string" ? new URL(req, "https://gw.example").href : req.url.split("?")[0])?.clone(),
      put: async (req: { url: string }, res: Response) => void m.set(req.url, res),
      addAll: async (urls: string[]) => urls.forEach((u) => m.set(new URL(u, "https://gw.example").href, new Response("cached"))),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      delete: async (k: Request) => m.delete(k.url),
    };
  };
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    location: new URL("https://gw.example/sw.js"),
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const caches = {
    open: async (n: string) => open(n),
    delete: async (n: string) => stores.delete(n),
    keys: async () => [...stores.keys()],
  };
  const context = vm.createContext({ self, caches, fetch: async (r: { url: string }) => network(r.url), URL, Request, Response, Headers, Promise, Date, Number, String, JSON });
  vm.runInContext(readFileSync(path.join(__dirname, "../../public/sw.js"), "utf8"), context);
  return {
    stores,
    async navigate(url: string) {
      let pending: Promise<Response> | undefined;
      listeners.fetch({ request: { url, method: "GET", mode: "navigate" }, respondWith: (p: Promise<Response>) => (pending = p) });
      return pending!;
    },
    async message(data: unknown) {
      let wait: Promise<unknown> | undefined;
      listeners.message({ data, waitUntil: (p: Promise<unknown>) => (wait = p) });
      await wait;
    },
  };
}

describe("service worker offline copies", () => {
  const page = (headers: Record<string, string> = {}) => () => new Response("<html>", { status: 200, headers: { "content-type": "text/html", ...headers } });

  it("keeps public pages for offline reading", async () => {
    const sw = serviceWorker(page());
    await sw.navigate("https://gw.example/districts");
    expect([...(sw.stores.get("gw-v2-shell")?.keys() ?? [])]).toContain("https://gw.example/districts");
  });

  it("never keeps staff pages or pages marked by the proxy", async () => {
    const sw = serviceWorker(page());
    await sw.navigate("https://gw.example/admin");
    await sw.navigate("https://gw.example/tw/admin");
    const marked = serviceWorker(page({ "x-gw-offline": "no-store" }));
    await marked.navigate("https://gw.example/reports/01a00000-0000-7000-8000-000000000001");
    expect(sw.stores.get("gw-v2-shell")?.size ?? 0).toBe(0);
    expect(marked.stores.get("gw-v2-shell")?.size ?? 0).toBe(0);
  });

  it("empties saved pages and API answers on sign-out, keeping the offline page", async () => {
    const sw = serviceWorker(page());
    await sw.navigate("https://gw.example/districts");
    await sw.message({ type: "clear-api-cache" });
    const shell = [...(sw.stores.get("gw-v2-shell")?.keys() ?? [])];
    expect(shell).not.toContain("https://gw.example/districts");
    expect(shell).toContain("https://gw.example/offline");
  });

  it("uses a new cache version, so copies made by the old worker are deleted on activation", () => {
    expect(readFileSync(path.join(__dirname, "../../public/sw.js"), "utf8")).toMatch(/const VERSION = "gw-v2"/);
  });
});

describe("app icons named by the manifest", () => {
  it("serves each icon as a PNG of the right size and nothing else", async () => {
    const { GET } = await import("@/app/icons/[name]/route");
    const sharp = (await import("sharp")).default;
    for (const [name, size] of [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["icon-maskable-512.png", 512],
    ] as const) {
      const res = await GET(new NextRequest(`http://localhost/icons/${name}`), { params: Promise.resolve({ name }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
    for (const name of ["../etc/passwd", "icon-1.png", "constructor", "__proto__"]) {
      expect((await GET(new NextRequest("http://localhost/icons/x"), { params: Promise.resolve({ name }) })).status).toBe(404);
    }
  });
});
