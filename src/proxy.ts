import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";

const intl = createIntlMiddleware(routing);

/**
 * Runs before every page request: locale routing (next-intl) plus the
 * security headers that must be present on every HTML response. API routes
 * set their own headers in src/lib/server/http.ts.
 */
export function proxy(request: NextRequest) {
  const response = intl(request) ?? NextResponse.next();
  applySecurityHeaders(response, request);
  // Staff pages, and any page rendered for a signed-in staff member (case pages show them pending photos
  // and exact spots), must not be kept by the service worker's offline copy of visited pages. Next.js
  // sends the same Cache-Control on every dynamic page, so this header is what public/sw.js reads.
  // (The cookie name is SESSION_COOKIE in src/lib/server/auth.ts, which cannot be imported here.)
  if (STAFF_PATH.test(request.nextUrl.pathname) || request.cookies.has("gw_session")) {
    response.headers.set("X-GW-Offline", "no-store");
  }
  return response;
}

const STAFF_PATH = /^\/(?:[a-z]{2}\/)?admin(?:\/|$)/;

function applySecurityHeaders(res: NextResponse, req: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  // Scorecard cards under /embed/ are made for other sites (news, assemblies) to frame; nothing else may be framed.
  const embeddable = /^\/(?:[a-z]{2}\/)?embed\//.test(req.nextUrl.pathname);
  // Basemap, plus Ground view's imagery, terrain and yearly mosaics (fetched by MapLibre as tiles).
  const mapHosts = [
    "https://tiles.openfreemap.org",
    "https://server.arcgisonline.com",
    "https://wayback.maptiles.arcgis.com",
    "https://tiles.maps.eox.at",
    "https://s3.amazonaws.com",
    // Long-term water history (flood-prone areas layer).
    "https://storage.googleapis.com",
  ];
  // Ground view's public photos from Wikimedia Commons are shown as plain images.
  const photoHosts = ["https://upload.wikimedia.org", "https://thumb.wikimedia.org"];
  // Google Street View opens inside Ground view only when the server has a Maps key.
  const frameHosts = "";
  const csp = [
    "default-src 'self'",
    // 'unsafe-inline' stays for scripts: Next.js inlines its runtime and the streamed page data, and the
    // only strict alternative, a per-request nonce, needs every page rendered on demand. Measured on
    // 2026-10-27: with a nonce the 99 prerendered shells each lost 14–29 script loads to the policy. The
    // site has no HTML sinks (React escapes all output; no dangerouslySetInnerHTML), so the policy's job
    // here is to pin script origins, frames, forms and base URIs. MapLibre needs blob: workers.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${mapHosts.join(" ")} ${photoHosts.join(" ")} https://wvs.earthdata.nasa.gov`,
    "font-src 'self' data:",
    `connect-src 'self' ${mapHosts.join(" ")}${isDev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    `child-src 'self' blob:${frameHosts}`,
    `frame-src 'self'${frameHosts}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    embeddable ? "frame-ancestors *" : "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  if (!embeddable) res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "geolocation=(self), camera=(self), microphone=(), payment=(), usb=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (req.nextUrl.protocol === "https:") {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
}

export const config = {
  // Everything except API routes, Next internals and static files with an extension.
  matcher: ["/((?!api|_next|_vercel|sw\\.js|.*\\..*).*)"],
};
