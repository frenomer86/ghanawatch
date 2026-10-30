"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import useSWR from "swr";
import { LocateFixed, MapPin, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fetcher } from "@/lib/client/fetcher";
import { useWatchlist, type WatchItem } from "@/lib/client/watchlist";
import type { ChangeEventSummary } from "@/lib/domain/types";
import type { BoundarySummary } from "@/lib/db/repo/boundaries";
import { PlaceSearch } from "@/components/map/place-search";
import { EventCard } from "@/components/domain/event-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";

/** Watchlist stored on the device, with the last 7 days of detections per area. */
export function MyArea() {
  const t = useTranslations("myArea");
  const tm = useTranslations("map");
  const { items, ready, add, remove } = useWatchlist();
  const [locating, setLocating] = useState(false);

  const addDistrict = (b: BoundarySummary) =>
    add({ id: `district:${b.code}`, kind: "district", name: b.parentName ? `${b.name}, ${b.parentName}` : b.name, lon: b.centroid.lon, lat: b.centroid.lat, bbox: b.bbox });

  const useLocation = () => {
    if (!navigator.geolocation) {
      toast.error(tm("locationUnavailable"));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude: lon, latitude: lat } = pos.coords;
        add({ id: `pt:${lon.toFixed(3)},${lat.toFixed(3)}`, kind: "point", name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lon, lat, radiusKm: 15 });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        toast.error(err.code === err.PERMISSION_DENIED ? tm("locationDenied") : tm("locationUnavailable"));
      },
      { timeout: 10_000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="mt-6 space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <PlaceSearch onSelect={addDistrict} className="flex-1" />
        <Button variant="outline" onClick={useLocation} disabled={locating} className="h-11 md:h-10">
          <LocateFixed className="size-4" aria-hidden />
          {t("useLocation")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("savedOnDevice")}</p>

      {ready && items.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <MapPin className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-medium">{t("empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("addDistrict")}</p>
        </div>
      )}

      {items.length > 0 && <p className="text-sm text-muted-foreground">{t("watching", { count: items.length })}</p>}
      <ul className="space-y-8">
        {items.map((item) => (
          <li key={item.id}>
            <AreaSection item={item} onRemove={() => remove(item.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AreaSection({ item, onRemove }: { item: WatchItem; onRemove: () => void }) {
  const t = useTranslations("myArea");
  const locale = useLocale();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const key =
    item.kind === "district" && item.bbox
      ? `/api/v1/events?bbox=${item.bbox.map((n) => n.toFixed(3)).join(",")}&since=${encodeURIComponent(since)}&limit=10&lang=${locale}`
      : `/api/v1/near?lon=${item.lon}&lat=${item.lat}&radiusKm=${item.radiusKm ?? 15}&limit=10&lang=${locale}`;
  const { data, isLoading } = useSWR<{ items: ChangeEventSummary[] }>(key, fetcher);
  const z = item.kind === "district" ? 9 : 11;
  return (
    <section aria-labelledby={`area-${item.id}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={`area-${item.id}`} className="text-lg font-semibold">
          <Link href={`/map?lat=${item.lat.toFixed(4)}&lon=${item.lon.toFixed(4)}&z=${z}`} className="hover:underline">
            {item.name}
          </Link>
        </h2>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`${t("remove")}: ${item.name}`}>
          <Trash2 className="size-4" aria-hidden />
          {t("remove")}
        </Button>
      </div>
      <ul className="mt-3 space-y-2">
        {isLoading && (
          <li>
            <Skeleton className="h-24 w-full" />
          </li>
        )}
        {data?.items.slice(0, 5).map((e) => (
          <li key={e.id}>
            <EventCard event={e} compact />
          </li>
        ))}
        {data && data.items.length === 0 && <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("noNewChanges")}</li>}
      </ul>
    </section>
  );
}
