import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { ChevronRight, ScanEye } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { reserveBySlug, scorecards } from "@/lib/db/repo/scorecards";
import { slugify } from "@/lib/domain/scorecards";
import { groundViewHref } from "@/lib/explore/imagery";
import { env } from "@/lib/server/env";
import { AppShell } from "@/components/layout/app-shell";
import { ScorecardNotes } from "@/components/scorecards/notes";
import { ShareBar } from "@/components/scorecards/share-bar";
import { Stat, fmtHa } from "@/components/scorecards/stat";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/reserves/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const r = await reserveBySlug(slug);
  if (!r) return { title: "Reserve not found" };
  return {
    title: r.card.name,
    description: `About ${fmtHa(r.card.miningHa)} ha of likely galamsey and ${fmtHa(r.card.clearedHa)} ha of cleared land seen from space inside ${r.card.name}.`,
  };
}

// Metadata depends on the reserve's live figures, so this route renders on request.
export const instant = false;

/** One forest reserve: likely mining and clearing inside it, the largest sites, and sharing. */
export default async function ReservePage({ params }: PageProps<"/[locale]/reserves/[slug]">) {
  const { locale } = await params;
  setRequestLocale(resolveLocale(locale));
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Reserve params={params} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Reserve({ params }: { params: PageProps<"/[locale]/reserves/[slug]">["params"] }) {
  await connection();
  const { slug } = await params;
  const r = await reserveBySlug(slug);
  if (!r) notFound();
  const all = await scorecards();
  const c = r.card;
  const url = `${env().PUBLIC_ORIGIN}/reserves/${c.slug}`;
  const rank = all.reserves.findIndex((x) => x.slug === c.slug) + 1;
  return (
    <article>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/districts" className="hover:underline">
          Districts
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <Link href="/reserves" className="hover:underline">
          Forest reserves
        </Link>
      </nav>
      <h1 className="mt-2 text-3xl font-semibold">{c.name}</h1>
      {c.districts.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          In{" "}
          {c.districts.map((d, i) => (
            <span key={d}>
              {i > 0 && (i === c.districts.length - 1 ? " and " : ", ")}
              <Link href={`/districts/${slugify(d)}`} className="text-link underline-offset-2 hover:underline">
                {d}
              </Link>
            </span>
          ))}
        </p>
      )}
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat tone="mining" label="Likely mining inside" value={`${fmtHa(c.miningHa)} ha`} sub={`${c.miningSites} sites`} />
        <Stat label="Cleared to bare ground" value={`${fmtHa(c.clearedHa)} ha`} sub="could also be farms" />
        <Stat tone="alert" label="Sites near people" value={String(c.nearPeople)} sub="within 300 m of homes, schools or clinics" />
        <Stat label="Rank among reserves" value={`${rank} of ${all.reserves.length}`} sub="by area affected" />
      </dl>
      {r.sites.length > 0 && (
        <section className="mt-8" aria-labelledby="sites-h">
          <h2 id="sites-h" className="text-xl font-semibold">
            Largest sites inside the reserve
          </h2>
          <ul className="mt-3 divide-y rounded-lg border">
            {r.sites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <Link href={`/event/${s.id}`} className="font-medium text-link underline-offset-2 hover:underline">
                    {s.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {s.imageDate ? `Seen by satellite ${new Date(s.imageDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={s.severity} />
                  <Button asChild variant="ghost" size="sm">
                    <Link href={groundViewHref(s.lat, s.lon, s.id)} aria-label={`Ground view of ${s.title}`}>
                      <ScanEye className="size-4" aria-hidden /> Ground view
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-8 rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-semibold">Share</h2>
        <ShareBar
          url={url}
          text={`${c.name}: about ${fmtHa(c.miningHa)} ha of likely galamsey seen from space inside the reserve. Live on GhanaWatch:`}
          cardUrl={c.districts[0] ? `/api/v1/scorecards/${slugify(c.districts[0])}/card` : "/districts"}
          cardName={`ghanawatch-${c.slug}.png`}
        />
      </section>
      <ScorecardNotes fireArchive={all.fireArchive} computedAt={all.computedAt} />
    </article>
  );
}
