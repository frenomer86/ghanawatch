/* GhanaWatch service worker.
 * Dependency-free so it builds under Turbopack. Strategies:
 *  - app shell + static assets: cache-first (immutable hashed URLs)
 *  - API reads (/api/v1/*): network-first with cached fallback, 24 h max age
 *  - basemap tiles and boundaries: stale-while-revalidate, LRU-capped
 *  - navigations: network-first, falling back to the cached page, then /offline. Staff pages and pages
 *    rendered for a signed-in staff member (marked X-GW-Offline: no-store by src/proxy.ts) are never kept.
 */
// v2: v1 kept every visited page, staff pages included; changing the version deletes those copies.
const VERSION = "gw-v2";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const API = `${VERSION}-api`;
const TILES = `${VERSION}-tiles`;
const TILE_LIMIT = 600;
const API_LIMIT = 150;
const API_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll([OFFLINE_URL, "/manifest.webmanifest"]).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  // Signing out empties the API cache and the saved pages so nothing read while signed in survives on the
  // device; the offline page and the manifest are fetched again.
  if (event.data && event.data.type === "clear-api-cache") {
    event.waitUntil(
      Promise.all([caches.delete(API), caches.delete(SHELL)])
        .then(() => caches.open(SHELL))
        .then((c) => c.addAll([OFFLINE_URL, "/manifest.webmanifest"]))
        .catch(() => undefined),
    );
    return;
  }
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
      event.respondWith(cacheFirst(STATIC, req));
      return;
    }
    if (url.pathname.startsWith("/boundaries/")) {
      event.respondWith(staleWhileRevalidate(TILES, req, TILE_LIMIT));
      return;
    }
    if (url.pathname.startsWith("/api/v1/")) {
      // Exports are large and never useful stale.
      if (url.searchParams.get("format") === "csv" || url.searchParams.get("format") === "geojson") return;
      // Imagery (satellite passes, street photos, detection crops) is immutable and already
      // cached by the browser; keeping it here would push the readable API answers out.
      if (/^\/api\/v1\/explore\/(pass|photo)\b/.test(url.pathname) || /\/image$/.test(url.pathname)) return;
      // Personal or staff-only answers never go into the on-device cache: location lookups, report
      // cases and their photos, sign-in state.
      if (/^\/api\/v1\/(near|cases|auth|admin)\b/.test(url.pathname)) return;
      event.respondWith(networkFirst(API, req, API_LIMIT));
      return;
    }
    if (req.mode === "navigate") {
      event.respondWith(navigation(req));
      return;
    }
    return;
  }

  // Cross-origin basemap tiles/styles/fonts.
  if (/tiles\.openfreemap\.org$/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(TILES, req, TILE_LIMIT));
  }
});

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(name, req, limit) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then(async (res) => {
      if (res.ok || res.type === "opaque") {
        await cache.put(req, res.clone());
        trim(cache, limit);
      }
      return res;
    })
    .catch(() => undefined);
  return hit || (await refresh) || Response.error();
}

async function networkFirst(name, req, limit) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    // The server says what may be kept: no-store and private answers are never written to the cache.
    const cc = (res.headers.get("cache-control") || "").toLowerCase();
    if (res.ok && !/no-store|private/.test(cc)) {
      const stamped = new Response(await res.clone().arrayBuffer(), {
        status: res.status,
        statusText: res.statusText,
        headers: withHeader(res.headers, "x-sw-cached-at", String(Date.now())),
      });
      await cache.put(req, stamped);
      trim(cache, limit);
    }
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) {
      const at = Number(hit.headers.get("x-sw-cached-at") || 0);
      if (Date.now() - at < API_MAX_AGE_MS) {
        return new Response(await hit.arrayBuffer(), {
          status: 200,
          headers: withHeader(hit.headers, "x-sw-offline", "1"),
        });
      }
    }
    return new Response(JSON.stringify({ error: "offline", message: "You are offline and no saved copy is available." }), {
      status: 503,
      headers: { "content-type": "application/json", "x-sw-offline": "1" },
    });
  }
}

const STAFF_PATH = /^\/(?:[a-z]{2}\/)?admin(?:\/|$)/;

async function navigation(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    const keep = res.ok && !res.redirected && res.headers.get("x-gw-offline") !== "no-store" && !STAFF_PATH.test(new URL(req.url).pathname);
    if (keep) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = STAFF_PATH.test(new URL(req.url).pathname) ? undefined : await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const offline = await cache.match(OFFLINE_URL);
    return offline || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

function withHeader(headers, key, value) {
  const h = new Headers(headers);
  h.set(key, value);
  return h;
}

async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}
