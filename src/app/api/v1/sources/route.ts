import type { NextRequest } from "next/server";
import { listSources } from "@/lib/db/repo/sources";
import { SOURCE_REGISTRY } from "@/pipeline/sources";
import { enforceRateLimit, handle, json } from "@/lib/server/http";

/** GET /api/v1/sources: data credits (provider, licence, attribution). How each source is used is not published. */
export const GET = handle(async (req: NextRequest) => {
  enforceRateLimit(req, "public");
  const items = (await listSources())
    .filter((s) => s.attributionText && LIVE.has(s.slug))
    .map((s) => ({ provider: s.provider.split(" (")[0], licence: s.licence, attribution: creditLine(s.attributionText) }));
  return json({ items }, { cache: "medium" });
});

const LIVE = new Set(SOURCE_REGISTRY.filter((r) => r.connection === "live").map((r) => r.slug));

/** The credit a licence asks for, without how the data was processed. */
function creditLine(text: string): string {
  return text.replace(/,? processed by .*$/, "").replace(/\s+$/, "");
}
