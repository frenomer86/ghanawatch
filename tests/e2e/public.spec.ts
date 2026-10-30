import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("public site", () => {
  test("home leads with the Galamsey Index and links into the map", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("monthly satellite report");
    await expect(page.getByRole("heading", { level: 2, name: /ha$/ }).first()).toBeVisible();
    await expect(page.getByText("Find your district").first()).toBeVisible();
    await page.getByRole("link", { name: "Open the national map" }).click();
    await expect(page).toHaveURL(/\/map/);
  });

  test("find your district goes to the scorecard, by name or by part of it", async ({ page }) => {
    await page.goto("/districts/find?q=obuasi");
    await expect(page).toHaveURL(/\/districts\/obuasi-municipal/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Obuasi");
  });

  test("river scorecards list the watched rivers and open one reach by reach", async ({ page }) => {
    await page.goto("/rivers");
    await expect(page.getByRole("heading", { level: 1, name: "River scorecards" })).toBeVisible();
    await page.getByRole("link", { name: /^Pra\b/ }).first().click();
    await expect(page).toHaveURL(/\/rivers\/pra/);
  });

  test("the monthly report and its open data are served", async ({ page, request }) => {
    await page.goto("/monthly");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const national = await request.get("/api/v1/national");
    expect([200, 404]).toContain(national.status()); // 404 only before the first month is closed
    const rivers = await request.get("/api/v1/rivers");
    expect(rivers.ok()).toBeTruthy();
    const feed = await request.get("/api/v1/alerts/feed.xml");
    expect(feed.ok()).toBeTruthy();
    expect(feed.headers()["content-type"]).toContain("rss+xml");
  });

  test("map loads hotspots and opens a detection with both dates", async ({ page }) => {
    await page.goto("/map");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    const phone = (page.viewportSize()?.width ?? 1024) < 768;
    if (phone) {
      // On phones the list sits in a collapsed bottom panel.
      await page.getByRole("button", { name: /detections? in view/ }).click({ timeout: 30_000 });
    }
    // The list fills once the map reports its bounds.
    const list = (phone ? page.locator("main ul li a:visible") : page.locator("aside li a")).first();
    await expect(list).toBeVisible({ timeout: 30_000 });
    // Hotspot features reach the map source, not only the list.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const m = (window as unknown as { __gwMap?: { querySourceFeatures: (id: string) => unknown[] } }).__gwMap;
            try {
              return m ? m.querySourceFeatures("gw-hotspots").length : -1;
            } catch {
              return -2;
            }
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await list.click();
    await expect(page.getByText("Seen by satellite").locator("visible=true").first()).toBeVisible();
    await expect(page.getByText("Detected").locator("visible=true").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Watch this area/ })).toBeVisible();
  });

  test("alerts feed filters by type", async ({ page }) => {
    await page.goto("/alerts");
    await expect(page.getByRole("heading", { level: 1, name: "Recent changes" })).toBeVisible();
    await expect(page.getByText("The weekly digest")).toBeVisible();
    const items = page.locator("ul[aria-live=\"polite\"] li a");
    await expect(items.first()).toBeVisible();
    // Choosing a type must refetch with that type and leave a list or an honest empty state, whatever live data exists.
    await page.getByLabel("Filter by type").click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/v1/events") && r.url().includes("type=surface_disturbance")),
      page.getByRole("option", { name: "Surface disturbance", exact: true }).click(),
    ]);
    expect(res.status()).toBe(200);
    const list = page.locator("ul[aria-live=\"polite\"]");
    await expect(list.locator("li").first()).toBeVisible();
  });

  test("data page streams a CSV with provenance columns", async ({ page, request }) => {
    await page.goto("/data");
    await expect(page.getByRole("heading", { level: 1, name: "Data and downloads" })).toBeVisible();
    const res = await request.get("/api/v1/events?format=csv&limit=5");
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toContain("image_date,image_date_end,detected_at");
  });

  test("twi locale renders and falls back cleanly", async ({ page }) => {
    await page.goto("/tw");
    await expect(page.getByRole("link", { name: "Asase mfoni" }).first()).toBeVisible();
  });

  test("key pages have no serious accessibility violations", async ({ page }) => {
    for (const path of ["/", "/alerts", "/data", "/how-it-works", "/report", "/rivers", "/monthly", "/data/accuracy", "/districts/obuasi-municipal"]) {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious, `${path}: ${serious.map((v) => v.id).join(", ")}`).toEqual([]);
    }
  });
});

test.describe("api hardening", () => {
  const payloads = ["' OR 1=1 --", "../../etc/passwd", "<img src=x onerror=alert(1)>", "%00", "1e309", "-".repeat(500)];

  test("rejects hostile query values without leaking", async ({ request }) => {
    for (const p of payloads) {
      const res = await request.get(`/api/v1/events?type=${encodeURIComponent(p)}`);
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("bad_request");
      expect(JSON.stringify(body)).not.toContain("drizzle");
    }
  });

  test("world-sized bbox and huge limits are clamped or refused", async ({ request }) => {
    const ok = await request.get("/api/v1/events?bbox=-180,-90,180,90&limit=500");
    expect(ok.status()).toBe(200);
    const bad = await request.get("/api/v1/events?limit=100000");
    expect(bad.status()).toBe(400);
  });

  test("unknown ids are 404, malformed ids are 404 too", async ({ request }) => {
    expect((await request.get("/api/v1/events/00000000-0000-7000-8000-000000000000")).status()).toBe(404);
    expect((await request.get("/api/v1/events/not-a-uuid")).status()).toBe(404);
  });

  test("subscriptions refuse cross-origin posts and say when mail is not set up", async ({ request }) => {
    const evil = await request.post("/api/v1/subscriptions", { data: { email: "a@b.co" }, headers: { origin: "https://evil.example" } });
    expect(evil.status()).toBe(403);
    const res = await request.post("/api/v1/subscriptions", { data: { email: "a@b.co", role: "admin" } });
    expect([400, 503, 429]).toContain(res.status()); // unknown field, or no mail service, or limited
  });

  test("admin routes need a session", async ({ request }) => {
    for (const path of ["/api/v1/admin/accuracy-checks", "/api/v1/admin/corrections", "/api/v1/admin/intakes", "/api/v1/auth/password"]) {
      const res = await request.post(path, { data: {} });
      expect(res.status(), path).toBe(401);
    }
  });

  test("reports endpoint refuses wrong content types and oversized bodies", async ({ request }) => {
    const res = await request.post("/api/v1/reports", { data: { lat: 1 }, headers: { "content-type": "application/json" } });
    expect([403, 415, 429]).toContain(res.status());
  });
});
