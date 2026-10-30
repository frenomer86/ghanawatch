import type { Metadata } from "next";
import { Suspense } from "react";
import { preconnect } from "react-dom";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { MapScreen } from "@/components/map/map-screen";
import { parseMapParams } from "@/components/map/map-params";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata({ params }: PageProps<"/[locale]/map">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "map" });
  return { title: t("title") };
}

export default async function MapPage({ params, searchParams }: PageProps<"/[locale]/map">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  // The style, sprites and tiles all come from the basemap host: open that connection in the page's
  // static shell, long before the map library asks for the style.
  try {
    preconnect(new URL(process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron").origin, { crossOrigin: "anonymous" });
  } catch {
    // a relative or malformed style URL needs no preconnect
  }
  return (
    <AppShell fullBleed>
      <Suspense fallback={<Skeleton className="h-[calc(100dvh-var(--gw-topbar-h))] w-full rounded-none" />}>
        <MapWithParams searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

async function MapWithParams({ searchParams }: { searchParams: PageProps<"/[locale]/map">["searchParams"] }) {
  const sp = await searchParams;
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";
  return <MapScreen styleUrl={styleUrl} initial={parseMapParams(sp)} />;
}
