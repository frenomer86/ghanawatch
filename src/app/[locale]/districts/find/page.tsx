import { redirect } from "next/navigation";
import { connection } from "next/server";
import { listDistrictNames } from "@/lib/db/repo/boundaries";
import { slugify } from "@/lib/domain/scorecards";
import { resolveDistrict } from "@/lib/domain/find-district";

// Resolves a typed district name at request time.
export const instant = false;

/** /districts/find?q=Name → the district's scorecard, or the ranking when the name is not known. */
export default async function FindDistrictPage({ params, searchParams }: PageProps<"/[locale]/districts/find">) {
  await connection();
  const { locale } = await params;
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim().slice(0, 80) ?? "";
  const prefix = locale === "en" ? "" : `/${locale}`;
  if (!q) redirect(`${prefix}/districts`);
  const names = await listDistrictNames();
  const target = resolveDistrict(q, names);
  if (target) redirect(`${prefix}/districts/${slugify(target)}`);
  redirect(`${prefix}/districts?q=${encodeURIComponent(q)}`);
}
