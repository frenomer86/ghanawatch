import type { MetadataRoute } from "next";
import { env } from "@/lib/server/env";

/** Public pages may be indexed; the admin area, the API and embeddable cards are left out of search engines. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/tw/admin", "/api/", "/embed/", "/tw/embed/"] }],
    host: env().PUBLIC_ORIGIN,
  };
}
