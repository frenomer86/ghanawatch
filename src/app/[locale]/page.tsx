import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeFeed } from "@/components/home/home-feed";
import { IndexHeadline } from "@/components/home/index-headline";
import { listPublicCases } from "@/lib/db/repo/cases";
import type { Locale } from "@/lib/domain/types";

export async function generateMetadata({ params }: PageProps<"/[locale]">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "home" });
  return { title: t("title"), description: t("intro") };
}

/**
 * Home. The month's finding as a sentence beside the district map, the trend and the ranked districts; then
 * what satellites flagged most recently and what people have reported from the ground. The interactive map
 * is one tap away; this page never loads the map library.
 */
export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <Suspense fallback={<Skeleton className="h-[34rem] w-full" />}>
          <IndexHeadline locale={locale} />
        </Suspense>

        <div className="mt-16 grid gap-12 border-t pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <section aria-labelledby="latest-h" className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="latest-h" className="text-2xl">Latest from the satellites</h2>
              <Link href="/alerts" className="text-[0.9375rem] text-link underline">
                All alerts
              </Link>
            </div>
            <Suspense fallback={<Skeleton className="mt-4 h-72 w-full" />}>
              <HomeFeed locale={locale} />
            </Suspense>
          </section>
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <FromTheGround locale={locale} />
          </Suspense>
        </div>
      </div>
    </AppShell>
  );
}

const CATEGORY: Record<string, string> = { galamsey: "Galamsey", dumping: "Rubbish dumping", fire: "Fire or burning", flooding: "Flooding", other: "Other damage" };

/** The newest published reports from the public, each linked to its case. */
async function FromTheGround({ locale }: { locale: Locale }) {
  await connection();
  const cases = await listPublicCases({ limit: 5 }).catch(() => []);
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale === "tw" ? "en-GB" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <section aria-labelledby="ground-h" className="min-w-0">
      <h2 id="ground-h" className="text-2xl">From the ground</h2>
      <p className="mt-1 text-[0.9375rem] text-muted-foreground">Reports sent by the public, checked against the photo&apos;s location and the satellite record.</p>
      {cases.length ? (
        <ul className="mt-4 divide-y border-y">
          {cases.map((c) => (
            <li key={c.id} className="py-3">
              <Link href={`/reports/${c.id}`} className="font-medium text-link underline-offset-2 hover:underline">
                {CATEGORY[c.category] ?? c.category}
                {c.districtName ? ` in ${c.districtName}` : ""}
              </Link>
              <p className="mt-0.5 line-clamp-2 text-[0.9375rem] text-ink-soft">{c.description}</p>
              <p className="mt-1 text-sm text-muted-foreground">Reported {day(c.createdAt)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[0.9375rem] text-muted-foreground">No reports have been published yet.</p>
      )}
      <p className="mt-4 text-[0.9375rem]">
        <Link href="/report" className="text-link underline">
          Report what you see
        </Link>
      </p>
    </section>
  );
}
