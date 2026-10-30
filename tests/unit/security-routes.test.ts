import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SQL } from "drizzle-orm";

/**
 * Security review, 30 October 2026: route handlers called directly with a Request, the database, mail
 * service and heavy renderers replaced by fakes (no database is needed).
 */

const state = vi.hoisted(() => ({
  existing: null as null | { id: string; confirmed_at: string | null },
  confirmRows: [] as Array<{ id: string }>,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  inserts: [] as unknown[],
  mails: [] as Array<{ to: string; text: string }>,
  pdfs: 0,
}));

vi.mock("@/lib/db/client", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    getDb: async () => ({
      execute: async (q: SQL) => {
        const query = dialect.sqlToQuery(q);
        state.queries.push(query);
        const text = query.sql.replace(/\s+/g, " ").trim();
        if (text.startsWith("select id::text, confirmed_at::text from alert_subscriptions")) return { rows: state.existing ? [state.existing] : [] };
        if (text.startsWith("update alert_subscriptions set confirmed_at")) return { rows: state.confirmRows };
        return { rows: [] };
      },
      insert: () => ({ values: async (v: unknown) => void state.inserts.push(v) }),
    }),
    rows: <T,>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? [])),
  };
});

vi.mock("@/lib/server/mail", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/mail")>();
  return {
    ...real,
    mailConfigured: () => true,
    sendMail: async (m: { to: string; text: string }) => {
      state.mails.push(m);
      return true;
    },
  };
});

// after() needs a live request scope; here the deferred work simply runs at once.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));

vi.mock("@/lib/server/alerts/digest", () => ({
  pastDigests: async () => [
    { weekEnding: "2026-10-26", newSites: 3, newHa: 4.5, districts: 1, createdAt: "2026-10-26T07:00:00Z", text: "*GhanaWatch weekly* • <script>alert(1)</script> inside Reserve & Co ]]> \u0000\u0008 done" },
  ],
}));

vi.mock("@/lib/server/scorecards/monthly", () => ({
  MONTH_RE: /^(20\d\d)-(0[1-9]|1[0-2])$/,
  availableMonths: async () => ["2026-09"],
  monthlyReport: async () => ({ month: "2026-09" }),
}));
vi.mock("@/lib/server/scorecards/monthly-pdf", () => ({
  monthlyPdf: async () => {
    state.pdfs++;
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  },
}));

vi.mock("@/lib/db/repo/events", () => ({
  iterateEvents: async function* () {},
  listEvents: async () => ({ items: [], nextCursor: null }),
}));

const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
let ipSeq = 0;
const freshIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;

function post(url: string, body: string, opts: { origin?: string; ip?: string; type?: string } = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": opts.type ?? "application/json", origin: opts.origin ?? "http://localhost:3000", "x-forwarded-for": opts.ip ?? freshIp() },
    body,
  });
}

beforeEach(() => {
  state.existing = null;
  state.confirmRows = [];
  state.queries = [];
  state.inserts = [];
  state.mails = [];
});

describe("POST /api/v1/subscriptions", () => {
  const subscribe = async (email: string, opts: { origin?: string } = {}) => {
    const { POST } = await import("@/app/api/v1/subscriptions/route");
    return POST(post("http://localhost:3000/api/v1/subscriptions", JSON.stringify({ email }), opts), ctx());
  };

  it("cannot be used to flood one inbox: at most 3 confirmation emails a day, the same answer every time", async () => {
    const victim = `victim-${Math.random()}@example.org`;
    const answers = [];
    for (let i = 0; i < 6; i++) {
      const res = await subscribe(victim);
      answers.push([res.status, await res.text()]);
    }
    expect(state.mails.filter((m) => m.to === victim)).toHaveLength(3);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0][0]).toBe(202);
  });

  it("does not reveal whether an address is already confirmed", async () => {
    const fresh = await subscribe(`new-${Math.random()}@example.org`);
    state.existing = { id: "01a00000-0000-7000-8000-000000000001", confirmed_at: "2026-10-01 10:00:00+00" };
    const known = await subscribe(`known-${Math.random()}@example.org`);
    expect([fresh.status, await fresh.text()]).toEqual([known.status, await known.text()]);
    expect(state.mails).toHaveLength(1); // only the new address is mailed
  });

  it("gives an unconfirmed request asked again a fresh token and restarts its clock", async () => {
    state.existing = { id: "01a00000-0000-7000-8000-000000000002", confirmed_at: null };
    await subscribe(`again-${Math.random()}@example.org`);
    const update = state.queries.find((q) => q.sql.includes("update alert_subscriptions set token"));
    expect(update?.sql).toContain("created_at = now()");
    expect(update?.sql).toContain("confirmed_at is null");
    const token = String(update?.params[0]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(state.mails[0].text).toContain(`token=${token}`);
  });

  it("refuses a cross-site request before touching the database", async () => {
    const res = await subscribe("x@example.org", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });

  it("refuses unknown keys and bad addresses", async () => {
    const { POST } = await import("@/app/api/v1/subscriptions/route");
    const extra = await POST(post("http://localhost:3000/api/v1/subscriptions", JSON.stringify({ email: "a@example.org", confirmedAt: "2026-01-01" })), ctx());
    expect(extra.status).toBe(400);
    const crlf = await POST(post("http://localhost:3000/api/v1/subscriptions", JSON.stringify({ email: "a@example.org\r\nBcc: b@example.org" })), ctx());
    expect(crlf.status).toBe(400);
  });
});

describe("POST /api/v1/subscriptions/confirm", () => {
  const token = "abcdefghijklmnopqrstuvwxyz012345";
  const confirm = async (body: string, opts: { origin?: string } = {}) => {
    const { POST } = await import("@/app/api/v1/subscriptions/confirm/route");
    return POST(post("http://localhost:3000/api/v1/subscriptions/confirm", body, { ...opts, type: "application/x-www-form-urlencoded" }), ctx());
  };

  it("only confirms a live token less than 7 days old", async () => {
    const res = await confirm(`token=${token}`);
    const q = state.queries.at(-1)!;
    expect(q.sql).toContain("unsubscribed_at is null");
    expect(q.sql).toContain("created_at > now() - interval '7 days'");
    expect(q.params).toContain(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/alerts?expired=1");
    state.confirmRows = [{ id: "x" }];
    expect((await confirm(`token=${token}`)).headers.get("location")).toBe("http://localhost:3000/alerts?subscribed=1");
  });

  it("refuses cross-site posts, malformed tokens and oversized bodies", async () => {
    expect((await confirm(`token=${token}`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await confirm(`token=bad"token`)).status).toBe(400);
    expect((await confirm(`token=${"a".repeat(10_000)}`)).status).toBe(413);
  });
});

describe("GET /api/v1/subscriptions/confirm", () => {
  it("shows a button and changes nothing", async () => {
    const { GET } = await import("@/app/api/v1/subscriptions/confirm/route");
    const res = await GET(new NextRequest("http://localhost:3000/api/v1/subscriptions/confirm?token=abcdefghijklmnopqrstuvwxyz012345"), ctx());
    expect(res.status).toBe(200);
    expect(state.queries).toHaveLength(0);
    expect(await res.text()).toContain('method="post"');
  });
});

describe("GET /api/v1/alerts/feed.xml", () => {
  it("escapes digest text, drops characters XML forbids, and is served inert", async () => {
    const { GET } = await import("@/app/api/v1/alerts/feed.xml/route");
    const res = await GET(new NextRequest("http://localhost:3000/api/v1/alerts/feed.xml", { headers: { "x-forwarded-for": freshIp() } }), ctx());
    const xml = await res.text();
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("Reserve &amp; Co ]]&gt;");
    expect(xml).not.toMatch(/[\u0000-\u0008]/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toContain("s-maxage");
  });
});

describe("expensive GETs count against the heavy limit", () => {
  it("monthly PDF: drawn once and shared, and an 11th request in a minute gets 429", async () => {
    const { GET } = await import("@/app/api/v1/monthly/[month]/pdf/route");
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await GET(new NextRequest("http://localhost:3000/api/v1/monthly/2026-09/pdf", { headers: { "x-forwarded-for": ip } }), ctx({ month: "2026-09" }))).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(state.pdfs).toBe(1);
  });

  it("event downloads (csv/geojson) use the heavy limit; a page of results does not", async () => {
    const { GET } = await import("@/app/api/v1/events/route");
    const ip = freshIp();
    const csv = [];
    for (let i = 0; i < 11; i++) csv.push((await GET(new NextRequest("http://localhost:3000/api/v1/events?format=csv", { headers: { "x-forwarded-for": ip } }), ctx())).status);
    expect(csv.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(csv[10]).toBe(429);
    const ip2 = freshIp();
    const pages = [];
    for (let i = 0; i < 11; i++) pages.push((await GET(new NextRequest("http://localhost:3000/api/v1/events?limit=10", { headers: { "x-forwarded-for": ip2 } }), ctx())).status);
    expect(pages.every((s) => s === 200)).toBe(true);
  });
});
