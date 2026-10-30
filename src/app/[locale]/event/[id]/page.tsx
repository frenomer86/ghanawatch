import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { uuidParam } from "@/lib/domain/validation";
import { getEvent } from "@/lib/db/repo/events";
import { AppShell } from "@/components/layout/app-shell";
import { EventDetail } from "@/components/domain/event-detail";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { MapPin, Rotate3d } from "lucide-react";
import { groundViewHref } from "@/lib/explore/imagery";
import { Suspense } from "react";

export async function generateMetadata({ params }: PageProps<"/[locale]/event/[id]">): Promise<Metadata> {
  const { locale: l, id } = await params;
  const locale = resolveLocale(l);
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) return {};
  const event = await getEvent(parsed.data, locale);
  if (!event) return {};
  return {
    title: event.title,
    description: `${event.districtName ?? ""}${event.regionName ? `, ${event.regionName}` : ""}. Image date ${event.imageDate}.`,
  };
}

// Metadata depends on the record itself, so this route renders on request.
export const instant = false;

/** Stand-alone, shareable record page. Same component as the map rail. */
export default async function EventPage({ params }: PageProps<"/[locale]/event/[id]">) {
  const { locale: l } = await params;
  const locale = resolveLocale(l);
  setRequestLocale(locale);
  return (
    <AppShell>
      <Suspense fallback={null}>
        <EventBody params={params} />
      </Suspense>
    </AppShell>
  );
}

async function EventBody({ params }: { params: PageProps<"/[locale]/event/[id]">["params"] }) {
  await connection();
  const { locale: l, id } = await params;
  const locale = resolveLocale(l);
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) notFound();
  const event = await getEvent(parsed.data, locale);
  if (!event) notFound();
  const t = await getTranslations({ locale, namespace: "event" });
  const tx = await getTranslations({ locale, namespace: "explore" });
  return (
    <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[1fr_minmax(0,20rem)]">
      <EventDetail event={event} />
      <aside className="space-y-2 lg:pt-1">
        <Button asChild className="w-full">
          <Link href={groundViewHref(event.centroid.lat, event.centroid.lon, event.id)}>
            <Rotate3d className="size-4" aria-hidden />
            {tx("groundView")}
          </Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link href={`/map?event=${event.id}&lat=${event.centroid.lat.toFixed(4)}&lon=${event.centroid.lon.toFixed(4)}&z=12`}>
            <MapPin className="size-4" aria-hidden />
            {t("openOnMap")}
          </Link>
        </Button>
      </aside>
    </div>
  );
}
