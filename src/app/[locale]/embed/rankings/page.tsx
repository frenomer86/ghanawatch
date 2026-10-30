import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { env } from "@/lib/server/env";
import { latestClosedMonth, rankings } from "@/lib/server/index/read";
import { fmtHa } from "@/components/scorecards/stat";

export const metadata: Metadata = { title: "GhanaWatch league table", robots: { index: false } };
export const instant = false;

/** The ten districts ranked highest in the latest closed month, sized for an iframe on a news site. */
export default async function EmbedRankings({ params }: PageProps<"/[locale]/embed/rankings">) {
  const { locale } = await params;
  setRequestLocale(resolveLocale(locale));
  return (
    <Suspense fallback={<div className="h-[360px] animate-pulse rounded-xl bg-muted" />}>
      <Table />
    </Suspense>
  );
}

async function Table() {
  await connection();
  const latest = await latestClosedMonth();
  const origin = env().PUBLIC_ORIGIN;
  if (!latest) return <p className="p-3 text-sm">The first monthly index has not been published yet.</p>;
  const rows = (await rankings(latest.month)).filter((r) => r.rank != null).slice(0, 10);
  return (
    <div className="mx-auto max-w-[560px] p-2">
      <div className="rounded-xl bg-forest-900 p-4 text-white">
        <div className="flex items-center justify-between text-xs text-white/75">
          <span className="font-heading text-sm font-semibold text-white">GhanaWatch · Galamsey Index</span>
          <span>{latest.label}</span>
        </div>
        <p className="mt-2 text-sm">
          <span className="font-heading text-2xl font-semibold text-[#f0b46a]">{fmtHa(latest.newHa)} ha</span> newly mined for gold, first seen from space
        </p>
        <ol className="mt-3 space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.districtId} className="flex items-baseline justify-between gap-2 border-t border-white/10 pt-1">
              <span>
                <span className="tabular-nums text-white/75">{r.rank}.</span>{" "}
                <a href={`${origin}/districts/${r.slug}`} target="_blank" rel="noopener" className="font-medium underline-offset-2 hover:underline">
                  {r.name}
                </a>
              </span>
              <span className="tabular-nums">
                {fmtHa(r.newHa)} ha <span className="text-white/60">· {r.index.toFixed(1)}/100 km²</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex items-center justify-between text-xs text-white/75">
          <span>Contains modified Copernicus Sentinel data · not a legal finding</span>
          <a href={`${origin}/districts`} target="_blank" rel="noopener" className="font-medium text-white underline">
            All districts
          </a>
        </div>
      </div>
    </div>
  );
}
