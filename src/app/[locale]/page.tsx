import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowRight, Database, FileText, MapIcon } from "lucide-react";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeOverview } from "@/components/home/home-overview";
import { HomeFeed } from "@/components/home/home-feed";
import { RiverWatch } from "@/components/home/river-watch";
import { GalamseyWatch } from "@/components/home/galamsey-watch";
import { IndexHeadline } from "@/components/home/index-headline";

export async function generateMetadata({ params }: PageProps<"/[locale]">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "home" });
  return { title: t("title"), description: t("intro") };
}

/**
 * Home. The number first: the latest closed month of the Galamsey Index, the trend, the ten districts
 * ranked highest and "find your district". The map, the live feed and the research entry points follow.
 * This page never loads the map library; the map is one tap away.
 */
export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "home" });
  const tAlerts = await getTranslations({ locale, namespace: "alerts" });
  return (
    <AppShell>
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-10">
        <div className="min-w-0">
          <h1 className="max-w-[24ch] text-3xl font-semibold leading-tight md:text-4xl md:leading-[1.1]">{t("title")}</h1>
          <p className="mt-3 max-w-[60ch] text-base text-ink-soft md:text-lg">{t("intro")}</p>
          <div className="mt-6">
            <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
              <IndexHeadline locale={locale} />
            </Suspense>
          </div>
        </div>
        <div className="min-w-0 space-y-6">
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/map">
                <MapIcon className="size-4" aria-hidden />
                {t("openMap")}
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/alerts">{t("viewAlerts")}</Link>
            </Button>
          </div>
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <HomeOverview locale={locale} />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <GalamseyWatch locale={locale} />
          </Suspense>
        </div>
      </section>

      <section className="mt-14 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-10">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-2xl font-semibold">{tAlerts("title")}</h2>
            <Link href="/alerts" className="inline-flex items-center gap-1 text-sm text-link underline">
              {t("viewAlerts")}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <Suspense
            fallback={
              <div className="mt-4 space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            }
          >
            <HomeFeed locale={locale} />
          </Suspense>
        </div>
        <div className="min-w-0 space-y-6">
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <RiverWatch locale={locale} compact />
          </Suspense>
          <aside className="rounded-xl border bg-card p-6">
            <h2 className="text-xl font-semibold">{t("forResearchers")}</h2>
            <p className="mt-3 text-ink-soft">{t("forResearchersBody")}</p>
            <ul className="mt-5 space-y-2">
              <li>
                <Link href="/data" className="flex items-center gap-3 rounded-md border px-3 py-2.5 hover:bg-accent">
                  <Database className="size-4 text-forest-700" aria-hidden />
                  <span className="font-medium">{t("browseData")}</span>
                </Link>
              </li>
              <li>
                <Link href="/data/methods" className="flex items-center gap-3 rounded-md border px-3 py-2.5 hover:bg-accent">
                  <FileText className="size-4 text-forest-700" aria-hidden />
                  <span className="font-medium">{t("readMethods")}</span>
                </Link>
              </li>
            </ul>
          </aside>
        </div>
      </section>
    </AppShell>
  );
}
