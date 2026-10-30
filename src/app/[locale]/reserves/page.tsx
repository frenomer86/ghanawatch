import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { ChevronRight } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { scorecards } from "@/lib/db/repo/scorecards";
import { AppShell } from "@/components/layout/app-shell";
import { ScorecardNotes } from "@/components/scorecards/notes";
import { fmtHa } from "@/components/scorecards/stat";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Forest reserves",
  description: "Forest reserves and other protected areas in Ghana where satellites show likely galamsey or cleared land.",
};

/** Forest reserves and other protected areas with likely mining or clearing inside them. */
export default async function ReservesPage({ params }: PageProps<"/[locale]/reserves">) {
  setRequestLocale(resolveLocale((await params).locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/districts" className="hover:underline">
            Districts
          </Link>
          <ChevronRight className="size-3.5" aria-hidden />
          <span>Forest reserves</span>
        </nav>
        <h1 className="mt-2 text-3xl font-semibold">Forest reserves</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Forest reserves, national parks and other protected areas mapped in OpenStreetMap where GhanaWatch&apos;s satellite detections show likely mining
          or land cleared to bare ground inside the boundary.
        </p>
        <Suspense fallback={<Skeleton className="mt-8 h-96 w-full" />}>
          <List />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function List() {
  await connection();
  const s = await scorecards();
  if (!s.reserves.length) {
    return <p className="mt-8 rounded-lg border border-dashed p-8 text-center text-muted-foreground">No likely mining or clearing inside mapped reserves in the current scan.</p>;
  }
  return (
    <>
      <div className="mt-6 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Forest reserves">
        <table className="gw-table">
          <thead>
            <tr>
              <th>Reserve</th>
              <th>Likely mining</th>
              <th>Cleared land</th>
              <th>Sites near people</th>
              <th>Districts</th>
            </tr>
          </thead>
          <tbody>
            {s.reserves.map((r) => (
              <tr key={r.slug}>
                <td>
                  <Link href={`/reserves/${r.slug}`} className="font-medium text-link underline-offset-2 hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="tabular-nums">
                  {r.miningHa > 0 ? `${fmtHa(r.miningHa)} ha` : "–"}
                  {r.miningSites > 0 && <div className="text-xs text-muted-foreground">{r.miningSites} sites</div>}
                </td>
                <td className="tabular-nums">{r.clearedHa > 0 ? `${fmtHa(r.clearedHa)} ha` : "–"}</td>
                <td className="tabular-nums">{r.nearPeople || "–"}</td>
                <td className="text-sm">{r.districts.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        Reserve boundaries come from OpenStreetMap, which maps about 90 of Ghana&apos;s protected areas; reserves it does not map are not listed yet.
      </p>
      <ScorecardNotes fireArchive={s.fireArchive} computedAt={s.computedAt} />
    </>
  );
}
