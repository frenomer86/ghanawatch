import type { NextRequest } from "next/server";
import { streetPhotoQuery } from "@/lib/domain/validation";
import { enforceRateLimit, handle, HttpError, parseQuery, readBody } from "@/lib/server/http";
import { resolveStreetPhoto } from "@/lib/server/explore/ground";
import { resolvesToPublic, userAgent } from "@/lib/server/explore/fetch";

/**
 * GET /api/v1/explore/photo?src=panoramax|mapillary&id=&size=thumb|full
 *
 * Street-level photo served from our own origin, so the 360° viewer can use
 * it as a WebGL texture and the page's security policy stays narrow. The image
 * URL is looked up from the provider's API by id; callers cannot pass a URL.
 */
const MAX_BYTES = 12 * 1024 * 1024;
const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const q = parseQuery(req, streetPhotoQuery);
  let url: string;
  try {
    url = await resolveStreetPhoto(q.src, q.id, q.size);
  } catch {
    throw new HttpError(404, "Photo not found");
  }
  // The photo's address comes from a federated catalogue (any Panoramax instance can list pictures), so
  // the host it names is checked to resolve only to public addresses, before the first request and again
  // at every redirect hop, which are followed by hand. Only raster image types are passed on: an SVG
  // served from this origin would be a page with scripts.
  let res: Response | null = null;
  let target = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!(await resolvesToPublic(target))) throw new HttpError(502, "Photo could not be loaded");
    const r = await fetch(target, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(20_000), redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get("location");
      if (!next) break;
      target = new URL(next, target).toString();
      continue;
    }
    res = r;
    break;
  }
  if (!res) throw new HttpError(502, "Photo could not be loaded");
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !RASTER.has(type)) throw new HttpError(502, "Photo could not be loaded");
  // Read through a byte ceiling: a host that streams without a length cannot fill the server's memory.
  const buf = await readBody(res, MAX_BYTES).catch(() => {
    throw new HttpError(502, "Photo too large");
  });
  return new Response(buf, {
    headers: {
      "content-type": type,
      "content-disposition": "inline; filename=photo",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "public, max-age=604800",
      "x-content-type-options": "nosniff",
    },
  });
});
