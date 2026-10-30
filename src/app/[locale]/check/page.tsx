import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { landQuery } from "@/lib/domain/validation";
import { AppShell } from "@/components/layout/app-shell";
import { LandCheck } from "@/components/land/land-check";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/check">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "land" });
  return { title: t("title"), description: t("intro") };
}

/** Check this land: what public satellite records say about any plot since 2020, with a PDF report. */
export default async function CheckPage({ params, searchParams }: PageProps<"/[locale]/check">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "land" });
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">{t("intro")}</p>
        <aside className="mt-4 max-w-3xl rounded-lg border border-forest-200 bg-forest-50 px-4 py-3 text-sm text-forest-900">
          <p className="font-medium">{t("eudrTitle")}</p>
          <p className="mt-1">{t("eudrBody")}</p>
        </aside>
        <Suspense fallback={<Skeleton className="mt-8 h-96 w-full" />}>
          <CheckWithParams searchParams={searchParams} />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function CheckWithParams({ searchParams }: { searchParams: PageProps<"/[locale]/check">["searchParams"] }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const parsed = landQuery.safeParse({ lat: one(sp.lat), lon: one(sp.lon), r: one(sp.r) ?? undefined });
  const initial = parsed.success ? { lat: Number(parsed.data.lat.toFixed(5)), lon: Number(parsed.data.lon.toFixed(5)), r: parsed.data.r } : null;
  return <LandCheck styleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron"} initial={initial} />;
}
