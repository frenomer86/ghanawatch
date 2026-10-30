import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { Link } from "@/i18n/navigation";
import { explorePointQuery, uuidParam } from "@/lib/domain/validation";
import type { Locale } from "@/lib/domain/types";
import { AppShell } from "@/components/layout/app-shell";
import { GroundView } from "@/components/explore/ground-view";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/explore">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "explore" });
  return { title: t("title"), description: t("intro") };
}

/** Ground view: any spot in Ghana in 3D, with its dated close-ups, satellite film and what is around it. */
export default async function ExplorePage({ params, searchParams }: PageProps<"/[locale]/explore">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell fullBleed>
      <Suspense fallback={<Skeleton className="h-[calc(100dvh-var(--gw-topbar-h))] w-full rounded-none" />}>
        <ExploreWithParams searchParams={searchParams} locale={locale} />
      </Suspense>
    </AppShell>
  );
}

async function ExploreWithParams({ searchParams, locale }: { searchParams: PageProps<"/[locale]/explore">["searchParams"]; locale: Locale }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const point = explorePointQuery.safeParse({ lat: one(sp.lat), lon: one(sp.lon) });
  const event = uuidParam.safeParse(one(sp.event));
  const modeParam = one(sp.mode);
  const mode = modeParam === "machinery" || modeParam === "film" ? modeParam : "photo";
  const releaseNum = Number(one(sp.release));
  const release = Number.isInteger(releaseNum) && releaseNum > 0 && releaseNum < 10_000_000 ? releaseNum : null;
  if (!point.success) {
    const t = await getTranslations({ locale, namespace: "explore" });
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-heading text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-3">{t("invalidPoint")}</p>
        <p className="mt-1 text-muted-foreground">{t("invalidHint")}</p>
        <Button asChild className="mt-6">
          <Link href="/map">{t("backToMap")}</Link>
        </Button>
      </div>
    );
  }
  return (
    <GroundView
      lat={Number(point.data.lat.toFixed(5))}
      lon={Number(point.data.lon.toFixed(5))}
      eventId={event.success ? event.data : null}
      initialMode={mode}
      initialRelease={release}
    />
  );
}
