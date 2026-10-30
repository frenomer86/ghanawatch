"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import useSWRInfinite from "swr/infinite";
import { fetcher } from "@/lib/client/fetcher";
import { CHANGE_TYPES, type ChangeEventSummary, type ChangeType } from "@/lib/domain/types";
import { EventCard } from "@/components/domain/event-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Page = { items: ChangeEventSummary[]; nextCursor: string | null };

export function AlertsFeed({ regions }: { regions: Array<{ id: string; name: string }> }) {
  const t = useTranslations("alerts");
  const tType = useTranslations("type");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [type, setType] = useState<string>("all");
  const [region, setRegion] = useState<string>("all");

  const getKey = (index: number, prev: Page | null) => {
    if (prev && !prev.nextCursor) return null;
    const sp = new URLSearchParams({ limit: "20", lang: locale });
    if (type !== "all") sp.set("type", type);
    if (region !== "all") sp.set("region", region);
    if (prev?.nextCursor) sp.set("cursor", prev.nextCursor);
    return `/api/v1/events?${sp}`;
  };

  const { data, error, isLoading, isValidating, setSize, size } = useSWRInfinite<Page>(getKey, fetcher, { revalidateFirstPage: false });
  const items = data?.flatMap((p) => p.items) ?? [];
  const hasMore = data ? Boolean(data[data.length - 1]?.nextCursor) : false;

  return (
    <section className="mt-6">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="feed-type" className="text-xs text-muted-foreground">
            {t("filterType")}
          </Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="feed-type" className="w-56">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allTypes")}</SelectItem>
              {CHANGE_TYPES.map((ty) => (
                <SelectItem key={ty} value={ty}>
                  {tType(ty as ChangeType)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="feed-region" className="text-xs text-muted-foreground">
            {t("filterRegion")}
          </Label>
          <Select value={region} onValueChange={setRegion}>
            <SelectTrigger id="feed-region" className="w-56">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allRegions")}</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r.id} value={r.name}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ul className="mt-6 space-y-3" aria-live="polite" aria-busy={isLoading}>
        {items.map((e) => (
          <li key={e.id}>
            <EventCard event={e} />
          </li>
        ))}
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="h-28 w-full" />
            </li>
          ))}
        {!isLoading && !error && items.length === 0 && <li className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">{t("empty")}</li>}
        {error && (
          <li className="rounded-lg border p-4 text-sm">
            <p>{tc("error")}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setSize(size)}>
              {tc("retry")}
            </Button>
          </li>
        )}
      </ul>
      {hasMore && (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={() => setSize(size + 1)} disabled={isValidating}>
            {t("loadMore")}
          </Button>
        </div>
      )}
    </section>
  );
}
