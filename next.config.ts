import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  reactStrictMode: true,
  // Native / filesystem-backed packages must not be bundled by Turbopack.
  serverExternalPackages: ["@electric-sql/pglite", "sharp", "@node-rs/argon2", "postgres"],
  // Server code reads files under process.cwd() (data, uploads), so the build's file tracing would otherwise walk
  // the whole project, including research outputs (gigabytes of training arrays) and local databases: it ran out
  // of memory. None of these are served by the site.
  outputFileTracingExcludes: {
    "*": ["research/**", "models/**", "tests/**", ".data/**", ".data-*/**", "docs/**", "test-results/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [],
  },
  async headers() {
    // Files under public/ never pass through src/proxy.ts (its matcher skips paths with a dot), so they get
    // their security headers here. Release files and the digest text are written from data that includes
    // OpenStreetMap names; nosniff plus a sandboxing policy means no browser ever runs anything in them.
    const inert = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
    ];
    return [
      {
        // Static boundaries are versioned by content; cache hard.
        source: "/boundaries/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }, { key: "X-Content-Type-Options", value: "nosniff" }],
      },
      {
        // Monthly release files: a month can be re-released after a correction, so an hour, then revalidate.
        source: "/releases/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }, ...inert],
      },
      {
        // public/alerts/latest.txt (the WhatsApp text of the weekly digest); never the /alerts page itself.
        source: "/alerts/:path+",
        headers: [{ key: "Cache-Control", value: "public, max-age=600" }, ...inert],
      },
      {
        // The map's 500 KB worker changes only with the MapLibre version.
        source: "/maplibre-gl-worker.mjs",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }, { key: "X-Content-Type-Options", value: "nosniff" }],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
