import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { districtBySlug } from "@/lib/db/repo/scorecards";
import { shareOfArea } from "@/lib/domain/scorecards";
import { env } from "@/lib/server/env";
import { fmtHa } from "@/components/scorecards/stat";

export const metadata: Metadata = { title: "GhanaWatch district card", robots: { index: false } };

// The district comes from the address, so this card renders on request.
export const instant = false;

/**
 * A district scorecard sized for other websites to embed in an iframe (news
 * sites, district assemblies). Always the latest figures; links back to the
 * full scorecard.
 */
export default async function EmbedDistrict({ params }: PageProps<"/[locale]/embed/district/[slug]">) {
  const { locale } = await params;
  setRequestLocale(resolveLocale(locale));
  return (
    <Suspense fallback={<div className="h-[320px] animate-pulse rounded-xl bg-muted" />}>
      <Card params={params} />
    </Suspense>
  );
}

async function Card({ params }: { params: PageProps<"/[locale]/embed/district/[slug]">["params"] }) {
  await connection();
  const { slug } = await params;
  const d = await districtBySlug(slug);
  if (!d) notFound();
  const c = d.card;
  const url = `${env().PUBLIC_ORIGIN}/districts/${c.slug}`;
  const share = shareOfArea(c.miningHa, c.areaKm2);
  return (
    <div className="mx-auto max-w-[560px] p-2">
      <div className="rounded-xl bg-forest-900 p-4 text-white">
        <div className="flex items-center justify-between text-xs text-white/75">
          <span className="font-heading text-sm font-semibold text-white">GhanaWatch</span>
          <span>District scorecard</span>
        </div>
        <p className="mt-3 font-heading text-2xl font-semibold leading-tight">{c.name}</p>
        <p className="text-sm text-white/75">{c.region}</p>
        <p className="mt-3 font-heading text-4xl font-semibold text-[#f0b46a]">{fmtHa(c.miningHa)} ha</p>
        <p className="text-sm">
          likely galamsey seen from space
          <span className="text-white/75">
            {c.rank ? ` · number ${c.rank} of ${d.total} districts` : " · none found in the current scan"}
            {share ? ` · ${share}% of the district` : ""}
          </span>
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-white/10 p-2">
            <dd className="font-heading text-lg font-semibold">{fmtHa(c.inReservesHa)} ha</dd>
            <dt className="text-[11px] text-white/75">in forest reserves</dt>
          </div>
          <div className="rounded-lg bg-white/10 p-2">
            <dd className="font-heading text-lg font-semibold">{c.nearPeople}</dd>
            <dt className="text-[11px] text-white/75">sites near homes or schools</dt>
          </div>
          <div className="rounded-lg bg-white/10 p-2">
            <dd className="font-heading text-lg font-semibold">{c.muddyRivers}</dd>
            <dt className="text-[11px] text-white/75">rivers turned muddy</dt>
          </div>
        </dl>
        <div className="mt-3 flex items-center justify-between text-xs text-white/75">
          <span>Contains modified Copernicus Sentinel data · not a legal finding</span>
          <a href={url} target="_blank" rel="noopener" className="font-medium text-white underline">
            Full scorecard
          </a>
        </div>
      </div>
    </div>
  );
}
