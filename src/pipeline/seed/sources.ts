import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { dataSources } from "@/lib/db/schema";
import { stableId } from "@/lib/server/ids";
import { SOURCE_REGISTRY } from "../sources";

export const sourceId = (slug: string) => stableId("source", slug);

export async function seedSources(db: Db, log: (s: string) => void) {
  await db
    .insert(dataSources)
    .values(
      SOURCE_REGISTRY.map((s) => ({
        id: sourceId(s.slug),
        slug: s.slug,
        name: s.name,
        provider: s.provider,
        url: s.url,
        docUrl: s.docUrl ?? null,
        category: s.category,
        description: s.description,
        licence: s.licence,
        attributionText: s.attributionText,
        cadence: s.cadence ?? null,
        resolutionM: s.resolutionM ?? null,
        isActive: s.isActive ?? true,
      })),
    )
    .onConflictDoUpdate({
      target: dataSources.slug,
      set: {
        name: sql`excluded.name`,
        provider: sql`excluded.provider`,
        url: sql`excluded.url`,
        docUrl: sql`excluded.doc_url`,
        category: sql`excluded.category`,
        description: sql`excluded.description`,
        licence: sql`excluded.licence`,
        attributionText: sql`excluded.attribution_text`,
        cadence: sql`excluded.cadence`,
        resolutionM: sql`excluded.resolution_m`,
        isActive: sql`excluded.is_active`,
        updatedAt: sql`now()`,
      },
    });
  log(`sources: ${SOURCE_REGISTRY.length} registered`);
}
