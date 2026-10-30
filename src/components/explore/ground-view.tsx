"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import useSWR from "swr";
import {
  ArrowLeft,
  Camera,
  Church,
  Copy,
  Cross,
  Hospital,
  ExternalLink,
  Film,
  Footprints,
  Images,
  MapPin,
  MousePointerClick,
  Orbit,
  RotateCcw,
  Rotate3d,
  ScanSearch,
  School,
  Tag,
  TreePine,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import { fetcher } from "@/lib/client/fetcher";
import type { ChangeEventDetail } from "@/lib/domain/types";
import {
  WORLD_IMAGERY_TILES,
  maxTileZoom,
  googleEarthUrl,
  googleStreetViewUrl,
  openStreetMapUrl,
  waybackTiles,
  type GroundPhoto,
  type GroundResponse,
  type HighResCapture,
  type ImageryResponse,
  type PassFrame,
  type PassesResponse,
  type PlaceKind,
  type Sighting,
  type StreetImage,
} from "@/lib/explore/imagery";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { FilmBar, type FilmBarFrame } from "./film-bar";
import { PanoCanvas } from "./pano-viewer";
import { MachineryPanel, TagForm } from "./machinery-panel";
import type { ExploreMapHandle, FilmFrame, MapPlace, MapSighting } from "./explore-map";

const ExploreMap = dynamic(() => import("./explore-map").then((m) => m.ExploreMap), {
  ssr: false,
  loading: () => <Skeleton className="absolute inset-0 rounded-none" />,
});
const MachineryCompare = dynamic(() => import("./machinery-compare").then((m) => m.MachineryCompare), {
  ssr: false,
  loading: () => <Skeleton className="absolute inset-0 rounded-none" />,
});

export type GroundMode = "photo" | "film" | "machinery";
/** Side-by-side close-ups shown at once: enough to compare, few enough to stay sharp on a laptop. */
const MAX_PANES = 4;

/** A pass is shown only if almost all of the square is clear and inside the swath. */
const MAX_CLOUD = 0.1;
const MAX_NODATA = 0.02;
const FRAME_MS = 1100;
const END_PAUSE_MS = 2600;

type Frame = FilmFrame & FilmBarFrame;
type CheckedPass = PassFrame & { cloud: number };

const KIND_ICON: Record<PlaceKind, typeof School> = { school: School, cemetery: Cross, health: Hospital, worship: Church, settlement: MapPin };

export function formatDistance(m: number) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

type PassCheck = { done: number; clear: CheckedPass[]; skipped: number };
const NO_CHECK: PassCheck = { done: 0, clear: [], skipped: 0 };

/**
 * Downloads each recent pass's frame (newest first, three at a time), reads the
 * cloud measure the server sends with it, and keeps the clear ones. The
 * download also warms the browser cache the 3D view draws from.
 */
function useClearPasses(passes: PassFrame[] | undefined): PassCheck {
  // Results are tagged with the list they belong to, so a new list starts from nothing without a reset.
  const [state, setState] = useState<PassCheck & { list?: PassFrame[] }>(NO_CHECK);
  useEffect(() => {
    if (!passes?.length) return;
    let cancelled = false;
    const queue = [...passes].reverse();
    const worker = async () => {
      for (let p = queue.shift(); p && !cancelled; p = queue.shift()) {
        const pass = p;
        let cloud = 1;
        let ok = false;
        try {
          const res = await fetch(pass.url);
          if (res.ok) {
            cloud = Number(res.headers.get("x-gw-cloud") ?? 1);
            const nodata = Number(res.headers.get("x-gw-nodata") ?? 1);
            await res.blob();
            ok = cloud <= MAX_CLOUD && nodata <= MAX_NODATA;
          }
        } catch {
          ok = false;
        }
        if (cancelled) return;
        setState((prev) => {
          const s = prev.list === passes ? prev : { ...NO_CHECK, list: passes };
          return {
            list: passes,
            done: s.done + 1,
            skipped: s.skipped + (ok ? 0 : 1),
            clear: ok ? [...s.clear, { ...pass, cloud }].sort((a, b) => a.date.localeCompare(b.date)) : s.clear,
          };
        });
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      cancelled = true;
    };
  }, [passes]);
  return state.list === passes ? state : NO_CHECK;
}

interface Props {
  lat: number;
  lon: number;
  eventId: string | null;
  initialMode?: GroundMode;
  initialRelease?: number | null;
}

export function GroundView({ lat, lon, eventId, initialMode = "photo", initialRelease = null }: Props) {
  const t = useTranslations("explore");
  const locale = useLocale();
  const f = useFormatter();
  const mapRef = useRef<ExploreMapHandle>(null);
  const q = `lat=${lat}&lon=${lon}`;
  const swrOpts = { revalidateOnFocus: false, dedupingInterval: 60_000 };
  const { data: imagery, isLoading: imageryLoading } = useSWR<ImageryResponse>(`/api/v1/explore/imagery?${q}`, fetcher, swrOpts);
  // Single passes are only looked up once someone opens the film: each one is a satellite file read.
  const [filmOpened, setFilmOpened] = useState(initialMode === "film");
  const { data: passesRes } = useSWR<PassesResponse>(filmOpened ? `/api/v1/explore/passes?${q}` : null, fetcher, swrOpts);
  const { data: ground, isLoading: groundLoading } = useSWR<GroundResponse>(`/api/v1/explore/ground?${q}`, fetcher, swrOpts);
  const { data: event } = useSWR<ChangeEventDetail>(eventId ? `/api/v1/events/${eventId}?lang=${locale}` : null, fetcher, swrOpts);
  const { data: sightingsRes, mutate: refreshSightings } = useSWR<{ items: Sighting[] }>(`/api/v1/sightings?${q}`, fetcher, swrOpts);
  const sightings = useMemo(() => sightingsRes?.items ?? [], [sightingsRes]);

  const day = (iso: string) => f.dateTime(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const month = (iso: string) => f.dateTime(new Date(`${iso.slice(0, 7)}-01T00:00:00Z`), { month: "short", timeZone: "UTC" });

  const [mode, setMode] = useState<GroundMode>(initialMode);
  const [release, setRelease] = useState<number | null>(initialRelease);
  const [orbit, setOrbit] = useState(initialMode !== "machinery");
  const [tagging, setTagging] = useState(false);
  const [draft, setDraft] = useState<{ lon: number; lat: number; capture: HighResCapture } | null>(null);
  const [paneFocus, setPaneFocus] = useState<{ lon: number; lat: number; key: number } | null>(null);
  const [labels, setLabels] = useState(true);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [street, setStreet] = useState<StreetImage | null>(null);
  const [photo, setPhoto] = useState<GroundPhoto | null>(null);
  const [googleOpen, setGoogleOpen] = useState(false);

  const captures = imagery?.highRes ?? [];
  const capture: HighResCapture | null = captures.find((c) => c.release === release) ?? captures[0] ?? null;
  const hiresTiles = capture ? waybackTiles(capture.release) : WORLD_IMAGERY_TILES;

  const years = imagery?.annualYears ?? [];
  const passCheck = useClearPasses(passesRes?.passes);
  const frames: Frame[] = useMemo(
    () => [
      ...years.map<Frame>((y) => ({ kind: "mosaic", key: `y${y}`, year: y, date: String(y), label: t("chipYear", { year: y }), short: String(y) })),
      ...passCheck.clear.map<Frame>((p) => ({
        kind: "pass",
        key: p.scene,
        date: p.date,
        url: p.url,
        corners: p.corners,
        label: t("chipPass", { date: day(p.date) }),
        short: month(p.date),
      })),
    ],
    // day/month/t are stable for a given locale
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [years, passCheck.clear, locale],
  );
  const frame = mode === "film" ? (frames[Math.min(frameIdx, frames.length - 1)] ?? null) : null;

  // Playback: step through the frames, hold on the newest, then start again.
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const atEnd = frameIdx >= frames.length - 1;
    const id = setTimeout(() => setFrameIdx(atEnd ? 0 : frameIdx + 1), atEnd ? END_PAUSE_MS : FRAME_MS);
    return () => clearTimeout(id);
  }, [playing, frameIdx, frames.length]);

  const startFilm = () => {
    setFilmOpened(true);
    setMode("film");
    setTagging(false);
    setDraft(null);
    setFrameIdx(0);
    setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };

  const changeMode = (v: string) => {
    if (v === "film") return startFilm();
    if (v !== "photo" && v !== "machinery") return;
    setMode(v);
    setPlaying(false);
    setTagging(false);
    setDraft(null);
    if (v === "machinery") setOrbit(false);
  };

  const sightingLabel = (s: Sighting) =>
    `${t(`sightingKind.${s.kind}`)}${s.count > 1 ? ` ×${s.count}` : ""}${s.capturedOn ? ` · ${day(s.capturedOn)}` : ""}`;
  const mapSightings: MapSighting[] = useMemo(
    () => sightings.map((s) => ({ lon: s.lon, lat: s.lat, kind: s.kind, label: sightingLabel(s) })),
    // sightingLabel only changes with the locale
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sightings, locale],
  );

  const places: MapPlace[] = useMemo(
    () => (ground?.places ?? []).map((p) => ({ ...p, label: `${p.name ?? t(`kind.${p.kind}`)} · ${formatDistance(p.distanceM)}` })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ground?.places, locale],
  );

  const placeName = [ground?.place.district, ground?.place.region].filter(Boolean).join(", ");
  const title = event?.title ?? (ground ? (ground.place.district ? t("spotTitle", { place: ground.place.district }) : t("spotTitleUnknown")) : t("title"));
  const coords = `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
  const latestPass = passCheck.clear[passCheck.clear.length - 1];

  const chip =
    mode === "film" && frame
      ? { title: frame.label, sub: frame.kind === "mosaic" ? t("chipYearSource") : t("chipPassSource") }
      : {
          title: capture?.capturedOn ? t("chipCloseup", { date: day(capture.capturedOn) }) : imageryLoading ? t("chipCloseupLoading") : t("chipCloseupUnknown"),
          sub: capture ? [capture.provider, capture.sensor, capture.resolutionM ? `${capture.resolutionM} m` : null].filter(Boolean).join(" · ") : "Esri World Imagery",
        };

  const detectedOn = event?.imageDateEnd ?? event?.imageDate ?? null;
  const newestCapture = captures[0] ?? null;
  const closeupOlder = Boolean(newestCapture?.capturedOn && detectedOn && newestCapture.capturedOn < detectedOn);

  const copyCoords = async () => {
    try {
      await navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
      toast.success(t("copied"));
    } catch {
      toast.message(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    }
  };

  const mapHref = `/map?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&z=14${eventId ? `&event=${eventId}` : ""}`;

  return (
    <div className="flex flex-col md:h-[calc(100dvh-var(--gw-topbar-h))] md:flex-row">
      {/* 3D viewport */}
      <div className="relative h-[62dvh] min-h-[380px] w-full md:h-full md:min-w-0 md:flex-1">
        <ExploreMap
          ref={mapRef}
          center={{ lon, lat }}
          hiresTiles={hiresTiles}
          hiresMaxZoom={maxTileZoom(capture)}
          mode={mode === "film" ? "film" : "photo"}
          annualYears={years}
          frame={frame}
          outline={event?.geometry ?? null}
          places={places}
          sightings={mapSightings}
          labels={labels}
          orbit={orbit && mode !== "machinery"}
          onOrbitChange={setOrbit}
          ariaLabel={t("mapLabel")}
        />

        {mode === "machinery" && (
          <div className="absolute inset-0 z-[5] bg-black">
            {captures.length > 0 ? (
              <MachineryCompare
                center={{ lon, lat }}
                captures={captures.slice(0, MAX_PANES)}
                sightings={sightings}
                outline={event?.geometry ?? null}
                tagging={tagging}
                draft={draft ? { lon: draft.lon, lat: draft.lat, release: draft.capture.release } : null}
                focus={paneFocus}
                onPick={(p) => setDraft(p)}
                paneTitle={(c) => ({
                  title: c.capturedOn ? day(c.capturedOn) : t("captureUnknown"),
                  sub: [c.provider, c.sensor, c.resolutionM ? `${c.resolutionM} m` : null].filter(Boolean).join(" · "),
                })}
                sightingLabel={sightingLabel}
                ariaLabel={(c) => (c.capturedOn ? t("paneLabel", { date: day(c.capturedOn) }) : t("paneLabelUnknown"))}
                newestLabel={t("newest")}
              />
            ) : (
              <p className="grid h-full place-items-center p-6 text-center text-sm text-white/80">{imageryLoading ? t("loading") : t("closeupNone")}</p>
            )}
          </div>
        )}

        {mode !== "machinery" && (
          <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[calc(100%-5rem)] rounded-md bg-black/65 px-3 py-2 text-white shadow-lg backdrop-blur-sm" aria-live="polite">
            <p className="text-sm font-semibold leading-snug">{chip.title}</p>
            <p className="mt-0.5 text-xs text-white/80">{chip.sub}</p>
          </div>
        )}

        {draft && (
          <div className="absolute inset-x-3 top-3 z-20 flex justify-center md:left-auto md:right-14 md:w-[26rem]">
            <TagForm
              draft={draft}
              eventId={eventId}
              day={day}
              onCancel={() => setDraft(null)}
              onSent={() => {
                setDraft(null);
                setTagging(false);
                void refreshSightings();
              }}
            />
          </div>
        )}

        <div className="absolute bottom-9 left-3 right-14 z-10 flex flex-col gap-2 md:right-3">
          {mode === "film" && frames.length > 0 && (
            <FilmBar
              frames={frames}
              index={Math.min(frameIdx, frames.length - 1)}
              playing={playing}
              onIndex={setFrameIdx}
              onPlaying={setPlaying}
              labels={{ play: t("play"), pause: t("pause"), previous: t("previous"), next: t("next"), timeline: t("timeline") }}
              className="max-w-3xl"
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" value={mode} onValueChange={changeMode} spacing={0} className="rounded-lg border bg-card/95 p-0.5 shadow-md" aria-label={t("modeLabel")}>
              <ToggleGroupItem value="photo" className="gap-1.5 px-2.5 text-sm sm:px-3">
                <Camera className="size-4" aria-hidden />
                {t("modePhoto")}
              </ToggleGroupItem>
              <ToggleGroupItem value="film" className="gap-1.5 px-2.5 text-sm sm:px-3">
                <Film className="size-4" aria-hidden />
                {t("modeFilm")}
              </ToggleGroupItem>
              <ToggleGroupItem value="machinery" className="gap-1.5 px-2.5 text-sm sm:px-3" aria-label={t("modeMachinery")}>
                <ScanSearch className="size-4" aria-hidden />
                {t("modeMachineryShort")}
              </ToggleGroupItem>
            </ToggleGroup>
            {mode === "machinery" ? (
              captures.length > 0 && (
                <Button
                  variant={tagging ? "default" : "outline"}
                  size="sm"
                  className={cn("h-9 shadow-md", !tagging && "bg-card/95")}
                  onClick={() => {
                    setTagging((v) => !v);
                    setDraft(null);
                  }}
                  aria-pressed={tagging}
                >
                  <MousePointerClick className="size-4" aria-hidden />
                  {tagging ? t("tagButtonActive") : t("tagButton")}
                </Button>
              )
            ) : (
              <>
                <Button variant="outline" size="sm" className="h-9 bg-card/95 shadow-md" onClick={() => setOrbit((o) => !o)} aria-pressed={orbit} aria-label={orbit ? t("orbitStop") : t("orbit")} title={orbit ? t("orbitStop") : t("orbit")}>
                  <Orbit className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{orbit ? t("orbitStop") : t("orbit")}</span>
                </Button>
                <Button variant="outline" size="sm" className="h-9 bg-card/95 shadow-md" onClick={() => setLabels((l) => !l)} aria-pressed={labels} aria-label={t("labels")} title={t("labels")}>
                  <Tag className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{t("labels")}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 bg-card/95 shadow-md"
                  aria-label={t("resetView")}
                  title={t("resetView")}
                  onClick={() => {
                    mapRef.current?.resetView();
                    setOrbit(true);
                  }}
                >
                  <RotateCcw className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{t("resetView")}</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Panel */}
      <aside className="w-full border-t bg-background md:w-[26rem] md:shrink-0 md:overflow-y-auto md:border-l md:border-t-0" aria-label={t("title")}>
        <div className="space-y-7 p-4 md:p-5">
          <header>
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
              <Rotate3d className="size-4" aria-hidden />
              {t("title")}
            </p>
            <h1 className="mt-1.5 font-heading text-xl font-semibold leading-tight">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{placeName || (groundLoading ? "…" : "Ghana")}</p>
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{coords}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={mapHref}>
                  <ArrowLeft className="size-4" aria-hidden />
                  {t("backToMap")}
                </Link>
              </Button>
              {eventId && (
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/event/${eventId}`}>{t("openRecord")}</Link>
                </Button>
              )}
            </div>
          </header>

          {/* What you are seeing */}
          {mode === "machinery" ? (
            <MachineryPanel
              lat={lat}
              lon={lon}
              captures={captures}
              sightings={sightings}
              day={day}
              formatDistance={formatDistance}
              onShow={(s) => setPaneFocus({ lon: s.lon, lat: s.lat, key: Date.now() })}
            />
          ) : mode === "photo" ? (
            <section aria-labelledby="gv-closeup">
              <h2 id="gv-closeup" className="flex items-center gap-1.5 text-sm font-semibold">
                <Camera className="size-4 text-muted-foreground" aria-hidden />
                {t("closeupHeading")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("closeupHelp")}</p>
              {closeupOlder && newestCapture?.capturedOn && detectedOn && (
                <p className="mt-3 flex gap-2 rounded-md border border-sev-elevated/30 bg-sev-elevated-tint/60 p-2.5 text-sm">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-sev-elevated" aria-hidden />
                  <span>{t("closeupOlder", { capture: day(newestCapture.capturedOn), detected: day(detectedOn) })}</span>
                </p>
              )}
              {imageryLoading && <Skeleton className="mt-3 h-24 w-full" />}
              {!imageryLoading && captures.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t("closeupNone")}</p>}
              {captures.length > 0 && (
                <ul className="mt-3 space-y-1.5" role="radiogroup" aria-labelledby="gv-closeup">
                  {captures.map((c, i) => {
                    const selected = c.release === capture?.release;
                    return (
                      <li key={c.release}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setRelease(c.release)}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60",
                            selected && "border-primary bg-accent",
                          )}
                        >
                          <span>
                            <span className="block font-medium">{c.capturedOn ? t("capturedOn", { date: day(c.capturedOn) }) : t("captureUnknown")}</span>
                            <span className="block text-xs text-muted-foreground">
                              {[c.provider, c.sensor, c.resolutionM ? `${c.resolutionM} m` : null].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                          {i === 0 && <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">{t("newest")}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Button className="mt-3 w-full" variant="secondary" onClick={startFilm}>
                <Film className="size-4" aria-hidden />
                {t("filmStart")}
              </Button>
            </section>
          ) : (
            <section aria-labelledby="gv-film">
              <h2 id="gv-film" className="flex items-center gap-1.5 text-sm font-semibold">
                <Film className="size-4 text-muted-foreground" aria-hidden />
                {t("filmHeading")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("filmHelp")}</p>
              <ul className="mt-3 space-y-1 text-sm">
                {years.length > 0 && <li>{t("filmYears", { count: years.length, first: years[0], last: years[years.length - 1] })}</li>}
                <li>{t("filmPasses", { count: passCheck.clear.length })}</li>
                {latestPass && <li className="font-medium">{t("filmLatest", { date: day(latestPass.date) })}</li>}
                {passesRes && passCheck.done < passesRes.passes.length && (
                  <li className="text-muted-foreground" aria-live="polite">
                    {t("filmChecking", { done: passCheck.done, total: passesRes.passes.length })}
                  </li>
                )}
                {passCheck.skipped > 0 && <li className="text-muted-foreground">{t("filmSkipped", { count: passCheck.skipped })}</li>}
              </ul>
            </section>
          )}

          {/* Around this spot */}
          <section aria-labelledby="gv-around">
            <h2 id="gv-around" className="flex items-center gap-1.5 text-sm font-semibold">
              <MapPin className="size-4 text-muted-foreground" aria-hidden />
              {t("aroundHeading")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("aroundHelp")}</p>
            {ground?.protectedArea && (
              <p className="mt-3 flex items-center gap-2 rounded-md border border-primary/30 bg-accent/60 p-2.5 text-sm font-medium">
                <TreePine className="size-4 text-primary" aria-hidden />
                {t("insideProtected", { name: ground.protectedArea })}
              </p>
            )}
            {groundLoading && <Skeleton className="mt-3 h-28 w-full" />}
            {ground && places.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t("aroundNone")}</p>}
            {places.length > 0 && (
              <ul className="mt-3 divide-y rounded-md border">
                {places.map((p) => {
                  const Icon = KIND_ICON[p.kind];
                  return (
                    <li key={`${p.kind}:${p.lon}:${p.lat}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{p.name ?? t(`kind.${p.kind}`)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`kind.${p.kind}`)} · {t("away", { distance: formatDistance(p.distanceM) })}
                        </span>
                      </span>
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => mapRef.current?.flyTo(p.lon, p.lat)}>
                        {t("showIn3d")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* From the ground */}
          <section aria-labelledby="gv-ground">
            <h2 id="gv-ground" className="flex items-center gap-1.5 text-sm font-semibold">
              <Footprints className="size-4 text-muted-foreground" aria-hidden />
              {t("groundHeading")}
            </h2>

            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("streetHeading")}</h3>
            {groundLoading && <Skeleton className="mt-2 h-20 w-full" />}
            {ground && ground.street.length === 0 && !ground.google && <p className="mt-1.5 text-sm text-muted-foreground">{t("streetNone")}</p>}
            {ground && ground.street.length > 0 && (
              <ul className="mt-2 grid grid-cols-3 gap-2">
                {ground.street.map((s) => (
                  <li key={`${s.source}:${s.id}`}>
                    <button type="button" onClick={() => setStreet(s)} className="group relative block aspect-[4/3] w-full overflow-hidden rounded-md border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element -- proxied provider thumbnail */}
                      <img src={s.thumbUrl} alt={`${s.source === "mapillary" ? "Mapillary" : "Panoramax"} photo ${formatDistance(s.distanceM)} away`} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                      {s.isPano && <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-white">{t("pano")}</span>}
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] text-white">{formatDistance(s.distanceM)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-col gap-1.5">
              {ground?.google && (
                <Button variant="outline" size="sm" className="justify-start" onClick={() => setGoogleOpen(true)}>
                  <Camera className="size-4" aria-hidden />
                  {t("googleInApp", { date: ground.google.date ?? "", distance: formatDistance(ground.google.distanceM) })}
                </Button>
              )}
              <a href={googleStreetViewUrl(lat, lon)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-link underline">
                {t("googleStreetView")}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
              <p className="text-xs text-muted-foreground">{t("googleStreetViewHelp")}</p>
            </div>

            <h3 className="mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Images className="size-3.5" aria-hidden />
              {t("photosHeading")}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("photosHelp")}</p>
            {groundLoading && <Skeleton className="mt-2 h-24 w-full" />}
            {ground && ground.photos.length === 0 && <p className="mt-1.5 text-sm text-muted-foreground">{t("photosNone")}</p>}
            {ground && ground.photos.length > 0 && (
              <ul className="mt-2 grid grid-cols-2 gap-2">
                {ground.photos.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setPhoto(p)} className="group block w-full overflow-hidden rounded-md border bg-card text-left">
                      <span className="block aspect-[4/3] overflow-hidden bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element -- Wikimedia Commons thumbnail */}
                        <img src={p.thumbUrl} alt={p.title} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                      </span>
                      <span className="block px-2 py-1.5">
                        <span className="line-clamp-2 block text-xs font-medium">{p.title}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {[p.takenOn, formatDistance(p.distanceM)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Elsewhere */}
          <section aria-labelledby="gv-open">
            <h2 id="gv-open" className="text-sm font-semibold">
              {t("openIn")}
            </h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={googleEarthUrl(lat, lon)} target="_blank" rel="noopener noreferrer">
                  {t("googleEarth")}
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={openStreetMapUrl(lat, lon)} target="_blank" rel="noopener noreferrer">
                  {t("openStreetMap")}
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </Button>
              <Button variant="ghost" size="sm" onClick={copyCoords}>
                <Copy className="size-4" aria-hidden />
                {t("copyCoords")}
              </Button>
            </div>
          </section>

          <footer className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t("credits")}</p>
            <ul className="mt-1 space-y-0.5">
              <li>Close-up: Powered by Esri. Esri World Imagery and Wayback (Vantor, Maxar, Airbus, Earthstar Geographics and the GIS User Community).</li>
              <li>Yearly views: Sentinel-2 cloudless by EOX IT Services GmbH, CC BY-NC-SA 4.0. Passes: contains modified Copernicus Sentinel data.</li>
              <li>Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1). Labels and places: © OpenStreetMap contributors, OpenFreeMap.</li>
              <li>Photos: Wikimedia Commons contributors, Panoramax{ground && !ground.needsKey.includes("mapillary") ? ", Mapillary" : ""}, each under its own licence.</li>
            </ul>
          </footer>
        </div>
      </aside>

      {/* Street-level viewer */}
      <Dialog open={Boolean(street)} onOpenChange={(o) => !o && setStreet(null)}>
        <DialogContent className="flex h-[85dvh] max-w-[calc(100%-1rem)] flex-col gap-2 p-2 sm:max-w-5xl">
          {street && (
            <>
              <DialogHeader className="px-2 pt-1">
                <DialogTitle className="text-base">
                  {street.source === "mapillary" ? "Mapillary" : "Panoramax"} · {street.takenOn ? day(street.takenOn) : ""} · {t("away", { distance: formatDistance(street.distanceM) })}
                </DialogTitle>
                <DialogDescription>{street.isPano ? t("viewerHelp") : (street.author ?? "")}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 overflow-hidden rounded-md">
                {street.isPano ? (
                  <PanoCanvas src={street.imageUrl} label={`360° photo taken ${street.takenOn ?? ""}`} loadingText={t("viewerLoading")} errorText={t("viewerError")} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- proxied provider image
                  <img src={street.imageUrl} alt={`Street-level photo taken ${street.takenOn ?? ""}`} className="h-full w-full bg-black object-contain" />
                )}
              </div>
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                {street.author ? `${street.author}, ` : ""}
                {street.licence}.{" "}
                <a href={street.pageUrl} target="_blank" rel="noopener noreferrer" className="text-link underline">
                  {t("openOriginal")}
                </a>
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Photo lightbox */}
      <Dialog open={Boolean(photo)} onOpenChange={(o) => !o && setPhoto(null)}>
        <DialogContent className="max-w-[calc(100%-1rem)] gap-2 p-2 sm:max-w-3xl">
          {photo && (
            <>
              <DialogHeader className="px-2 pt-1">
                <DialogTitle className="pr-8 text-base leading-snug">{photo.title}</DialogTitle>
                <DialogDescription>{[photo.takenOn, t("away", { distance: formatDistance(photo.distanceM) })].filter(Boolean).join(" · ")}</DialogDescription>
              </DialogHeader>
              {/* eslint-disable-next-line @next/next/no-img-element -- Wikimedia Commons image */}
              <img src={photo.largeUrl} alt={photo.title} className="max-h-[70dvh] w-full rounded-md bg-black object-contain" />
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                {photo.author ? `${t("photoBy", { author: photo.author })}. ` : ""}
                {photo.licenceUrl ? (
                  <a href={photo.licenceUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    {photo.licence}
                  </a>
                ) : (
                  photo.licence
                )}
                .{" "}
                <a href={photo.pageUrl} target="_blank" rel="noopener noreferrer" className="text-link underline">
                  {t("openOriginal")}
                </a>
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Google Street View, only when this server has a key */}
      <Dialog open={googleOpen} onOpenChange={setGoogleOpen}>
        <DialogContent className="flex h-[85dvh] max-w-[calc(100%-1rem)] flex-col gap-2 p-2 sm:max-w-5xl">
          <DialogHeader className="px-2 pt-1">
            <DialogTitle className="text-base">Google Street View</DialogTitle>
            <DialogDescription>{ground?.google?.date ?? ""}</DialogDescription>
          </DialogHeader>
          {ground?.google && googleOpen && (
            <iframe title="Google Street View" src={ground.google.embedUrl} className="min-h-0 w-full flex-1 rounded-md border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
