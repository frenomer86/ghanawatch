"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import useSWR from "swr";
import type { FeatureCollection } from "geojson";
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, PanelLeftClose, PanelLeftOpen, Rotate3d, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { groundViewHref } from "@/lib/explore/imagery";
import { fetcher } from "@/lib/client/fetcher";
import { useDebouncedValue } from "@/lib/client/use-debounced";
import { CHANGE_TYPES, type BBox, type ChangeEventDetail, type ChangeEventSummary, type ChangeType } from "@/lib/domain/types";
import type { BoundarySummary } from "@/lib/db/repo/boundaries";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EventCard } from "@/components/domain/event-card";
import { EventDetail } from "@/components/domain/event-detail";
import { Legend } from "./legend";
import { PlaceSearch } from "./place-search";
import { FilterMenu, TimeWindow } from "./filters";
import { FreshnessChip } from "./freshness-chip";
import type { HotspotProps, MapHandle } from "./map-view";
import type { MapFilters, MapInitialState, ViewState } from "./map-params";
import { cn } from "@/lib/utils";

// The map library is about 1 MB. Its download starts as soon as this module runs in the browser, in
// parallel with hydration, instead of after the page has hydrated and rendered the placeholder.
const loadMapView = () => import("./map-view").then((m) => m.MapView);
if (typeof window !== "undefined") void loadMapView().catch(() => undefined);
const MapView = dynamic(loadMapView, {
  ssr: false,
  loading: () => <Skeleton className="absolute inset-0 rounded-none" />,
});

interface Props {
  styleUrl: string;
  initial: MapInitialState;
}

/**
 * The national map screen. URL search params are the source of truth for the
 * view and filters so every state is shareable; the map, the list of
 * detections in view and the detail panel all derive from them.
 */
export function MapScreen({ styleUrl, initial }: Props) {
  const t = useTranslations("map");
  const te = useTranslations("event");
  const tx = useTranslations("explore");
  const tc = useTranslations("common");
  const tType = useTranslations("type");
  const locale = useLocale();
  const mapRef = useRef<MapHandle>(null);
  const [view, setView] = useState<ViewState>(initial.view);
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [cell, setCell] = useState(0.1);
  const [filters, setFilters] = useState<MapFilters>(initial.filters);
  const [eventId, setEventId] = useState<string | null>(initial.eventId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  // Desktop list panel: slides away so the map gets the whole screen, and comes back from the edge tab.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("gw-map-rail") === "closed") setRailOpen(false);
    } catch {}
  }, []);
  const toggleRail = () => {
    setRailOpen((open) => {
      try {
        localStorage.setItem("gw-map-rail", open ? "closed" : "open");
      } catch {}
      return !open;
    });
  };
  const [hover, setHover] = useState<{ p: HotspotProps; x: number; y: number } | null>(null);
  const [spot, setSpot] = useState<{ lon: number; lat: number; x: number; y: number } | null>(null);
  const debouncedBbox = useDebouncedValue(bbox, 250);
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // A navigation to /map?event=… while the screen is mounted (e.g. from a shared link) opens that record.
  const [seenInitialEvent, setSeenInitialEvent] = useState(initial.eventId);
  if (initial.eventId !== seenInitialEvent) {
    setSeenInitialEvent(initial.eventId);
    if (initial.eventId) setEventId(initial.eventId);
  }

  // Reflect state in the URL without triggering navigation.
  useEffect(() => {
    const sp = new URLSearchParams();
    sp.set("lat", view.lat.toFixed(4));
    sp.set("lon", view.lon.toFixed(4));
    sp.set("z", view.zoom.toFixed(2));
    if (filters.hours !== 72) sp.set("hours", String(filters.hours));
    if (filters.type) sp.set("type", filters.type);
    if (filters.severity) sp.set("sev", filters.severity);
    if (filters.districts) sp.set("districts", "1");
    if (filters.possible) sp.set("possible", "1");
    if (filters.floodProne) sp.set("flood", "1");
    if (eventId) sp.set("event", eventId);
    const url = `${window.location.pathname}?${sp.toString()}`;
    window.history.replaceState(window.history.state, "", url);
  }, [view, filters, eventId]);

  const sinceParams = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("hours", String(filters.hours));
    if (filters.type) sp.set("type", filters.type);
    if (filters.severity) sp.set("severity", filters.severity);
    if (filters.possible) sp.set("possible", "1");
    return sp;
  }, [filters]);

  const bboxStr = debouncedBbox ? debouncedBbox.map((n) => n.toFixed(3)).join(",") : null;

  const hotspotsKey = bboxStr ? `/api/v1/hotspots?${sinceParams}&cell=${cell}&bbox=${bboxStr}` : null;
  const { data: hotspots } = useSWR<FeatureCollection>(hotspotsKey, fetcher, { keepPreviousData: true });

  const footprintsKey = bboxStr && view.zoom >= 10 ? `/api/v1/footprints?${sinceParams}&bbox=${bboxStr}` : null;
  const { data: footprints } = useSWR<FeatureCollection>(footprintsKey, fetcher, { keepPreviousData: true });

  const [openedAt] = useState(() => Date.now());
  const since = useMemo(() => new Date(openedAt - filters.hours * 3_600_000).toISOString(), [openedAt, filters.hours]);
  const listKey = bboxStr
    ? `/api/v1/events?bbox=${bboxStr}&since=${encodeURIComponent(since)}${filters.type ? `&type=${filters.type}` : ""}${filters.severity ? `&severity=${filters.severity}` : ""}${filters.possible ? "&possible=1" : ""}&limit=40&lang=${locale}`
    : null;
  const { data: list, isLoading: listLoading } = useSWR<{ items: ChangeEventSummary[]; nextCursor: string | null }>(listKey, fetcher, {
    keepPreviousData: true,
  });

  const { data: detail, isLoading: detailLoading, error: detailError } = useSWR<ChangeEventDetail>(
    eventId ? `/api/v1/events/${eventId}?lang=${locale}` : null,
    fetcher,
  );

  // When a detection is opened from a link, bring it into view once.
  const flewTo = useRef<string | null>(null);
  useEffect(() => {
    if (detail && flewTo.current !== detail.id) {
      flewTo.current = detail.id;
      if (initial.eventId === detail.id && view.zoom < 9) mapRef.current?.fitBounds(detail.bbox, 120);
    }
  }, [detail, initial.eventId, view.zoom]);

  const onViewChange = useCallback((v: ViewState, b: BBox, c: number) => {
    setSpot(null);
    setView(v);
    setBbox(b);
    setCell(c);
  }, []);

  const onHotspotClick = useCallback((p: HotspotProps) => {
    if (p.count === 1) {
      setEventId(p.sampleId);
      setSelectedKey(p.key);
    } else {
      mapRef.current?.fitBounds(p.bbox, 80);
    }
  }, []);

  const onFootprintClick = useCallback((id: string) => setEventId(id), []);

  const onPlace = (b: BoundarySummary) => {
    setEventId(null);
    mapRef.current?.fitBounds(b.bbox, 40);
  };

  const closeDetail = () => {
    setEventId(null);
    setSelectedKey(null);
  };

  const items = list?.items ?? [];

  return (
    <div className="relative flex h-[calc(100dvh-var(--gw-topbar-h)-var(--gw-bottomnav-h))] w-full md:h-[calc(100dvh-var(--gw-topbar-h))]">
      {/* Desktop rail */}
      <aside
        className={cn("hidden shrink-0 flex-col overflow-hidden bg-background transition-[width] duration-200 md:flex", railOpen ? "w-rail border-r" : "w-0")}
        inert={!railOpen} aria-label={eventId ? te("image") : t("eventsInView", { count: items.length })}>
        {eventId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Button variant="ghost" size="sm" onClick={closeDetail}>
                <ArrowLeft className="size-4" aria-hidden />
                {te("back")}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <DetailBody detail={detail} loading={detailLoading} error={Boolean(detailError)} />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-4 py-3">
              <h1 className="font-heading text-lg font-semibold">{t("title")}</h1>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {listLoading && !list ? "…" : t("eventsInView", { count: items.length })}
              </p>
            </div>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {items.map((e) => (
                <li key={e.id}>
                  <EventCard
                    event={e}
                    compact
                    href={`/map?event=${e.id}&lat=${e.centroid.lat.toFixed(4)}&lon=${e.centroid.lon.toFixed(4)}&z=12`}
                    onSelect={(ev) => {
                      setEventId(ev.id);
                      setSelectedKey(null);
                      mapRef.current?.flyTo({ lon: ev.centroid.lon, lat: ev.centroid.lat, zoom: Math.max(view.zoom, 10) });
                    }}
                  />
                </li>
              ))}
              {!listLoading && items.length === 0 && (
                <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{t("noChanges")}</p>
                  <p className="mt-1">{t("noChangesHint")}</p>
                </li>
              )}
            </ul>
          </div>
        )}
      </aside>

      {/* Map */}
      <div className="relative min-w-0 flex-1">
        <MapView
          ref={mapRef}
          styleUrl={styleUrl}
          initialView={initial.view}
          showDistricts={filters.districts}
          showFloodProne={filters.floodProne}
          hotspots={hotspots ?? null}
          footprints={view.zoom >= 10 ? footprints ?? null : null}
          selectedKey={selectedKey}
          onViewChange={onViewChange}
          onHotspotClick={onHotspotClick}
          onFootprintClick={onFootprintClick}
          onHover={(p, pt) => setHover(p && pt ? { p, x: pt.x, y: pt.y } : null)}
          onMapClick={setSpot}
          locateLabel={t("nearMe")}
        />

        <button
          type="button"
          onClick={toggleRail}
          aria-expanded={railOpen}
          aria-label={railOpen ? t("hidePanel") : t("showPanel")}
          title={railOpen ? t("hidePanel") : t("showPanel")}
          className="absolute left-0 top-1/2 z-20 hidden h-14 w-6 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 bg-card text-muted-foreground shadow-sm hover:text-foreground md:flex"
        >
          {railOpen ? <PanelLeftClose className="size-4" aria-hidden /> : <PanelLeftOpen className="size-4" aria-hidden />}
        </button>

        {/* Controls */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-3">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 md:max-w-3xl">
            <PlaceSearch onSelect={onPlace} className="w-full min-w-0 sm:w-72" />
            <TimeWindow value={filters.hours} onChange={(h) => setFilters({ ...filters, hours: h })} className="hidden sm:inline-flex" />
            <FilterMenu value={filters} onChange={setFilters} />
            <Button variant="outline" size="icon" className="hidden h-10 bg-card shadow-sm sm:inline-flex" aria-label={t("resetView")} onClick={() => mapRef.current?.resetView()}>
              <Maximize2 className="size-4" aria-hidden />
            </Button>
          </div>
          <div className="pointer-events-auto sm:hidden">
            <TimeWindow value={filters.hours} onChange={(h) => setFilters({ ...filters, hours: h })} className="max-w-full overflow-x-auto" />
          </div>
          <FreshnessChip className="pointer-events-auto w-fit max-w-full" />
        </div>

        <Legend className="absolute bottom-8 left-3 z-10 hidden w-56 lg:block" />

        {hover && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-20 max-w-60 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
          >
            <p className="font-medium">{hover.p.district ?? "Ghana"}</p>
            <p className="text-muted-foreground">
              {hover.p.count} {hover.p.count === 1 ? "detection" : "detections"}, {CHANGE_TYPES.includes(hover.p.type as ChangeType) ? tType(hover.p.type as ChangeType) : hover.p.type}
            </p>
            <p className="text-muted-foreground">
              {te("seenBySatellite")} {hover.p.latestImageDate}
            </p>
          </div>
        )}

        {spot && (
          <div
            role="dialog"
            aria-label={tx("exploreSpot")}
            className="absolute z-20 w-64 rounded-lg border bg-popover p-3 text-sm shadow-lg"
            style={{ left: `min(${spot.x + 12}px, calc(100% - 17rem))`, top: `min(${spot.y + 12}px, calc(100% - 11rem))` }}
            onKeyDown={(e) => e.key === "Escape" && setSpot(null)}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{tx("exploreSpot")}</p>
              <button type="button" className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={tc("close")} onClick={() => setSpot(null)}>
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
              {spot.lat.toFixed(5)}, {spot.lon.toFixed(5)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{tx("exploreSpotHelp")}</p>
            <Button asChild size="sm" className="mt-2.5 w-full">
              <Link href={groundViewHref(spot.lat, spot.lon)}>
                <Rotate3d className="size-4" aria-hidden />
                {tx("groundView")}
              </Link>
            </Button>
          </div>
        )}

        {/* Mobile list panel */}
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 flex flex-col rounded-t-xl border-t bg-background shadow-[0_-4px_16px_rgba(0,0,0,0.08)] transition-[height] md:hidden",
            listOpen ? "h-[55%]" : "h-12",
          )}
        >
          <button
            type="button"
            className="flex h-12 w-full items-center justify-between px-4 text-sm font-medium"
            aria-expanded={listOpen}
            onClick={() => setListOpen((o) => !o)}
          >
            <span>{t("eventsInView", { count: items.length })}</span>
            {listOpen ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
          </button>
          {listOpen && (
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              {items.map((e) => (
                <li key={e.id}>
                  <EventCard event={e} compact href={`/event/${e.id}`} onSelect={(ev) => setEventId(ev.id)} />
                </li>
              ))}
              {!listLoading && items.length === 0 && <li className="p-3 text-sm text-muted-foreground">{t("noChanges")}</li>}
            </ul>
          )}
        </div>
      </div>

      {/* Mobile detail sheet */}
      {/* Phones only; on wider screens the rail shows the detail and no overlay is wanted. */}
      <Sheet open={Boolean(eventId) && isPhone} onOpenChange={(o) => !o && closeDetail()}>
        <SheetContent side="bottom" className="h-[88dvh] overflow-y-auto rounded-t-xl p-0 md:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>{detail?.title ?? te("image")}</SheetTitle>
          </SheetHeader>
          <div className="p-4 pt-6">
            <DetailBody detail={detail} loading={detailLoading} error={Boolean(detailError)} showOpenFull />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailBody({ detail, loading, error, showOpenFull }: { detail?: ChangeEventDetail; loading: boolean; error: boolean; showOpenFull?: boolean }) {
  const tc = useTranslations("common");
  if (detail) return <EventDetail event={detail} showOpenFull={showOpenFull} />;
  if (loading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="aspect-[16/10] w-full" />
      </div>
    );
  if (error) return <p className="text-sm text-muted-foreground">{tc("error")}</p>;
  return null;
}

