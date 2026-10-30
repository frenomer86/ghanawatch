"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { Download, LocateFixed, Rotate3d, Search, Share2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import { fetcher } from "@/lib/client/fetcher";
import { LAND_RADII, type LandChange, type LandSummary } from "@/lib/domain/land";
import { findings, ha } from "@/lib/domain/land-findings";
import { groundViewHref } from "@/lib/explore/imagery";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const PinPicker = dynamic(() => import("@/components/map/pin-picker").then((m) => m.PinPicker), {
  ssr: false,
  loading: () => <div className="h-[17.5rem] animate-pulse rounded-md border bg-muted" />,
});

interface Props {
  styleUrl: string;
  initial: { lat: number; lon: number; r: number } | null;
}

/**
 * Check this land: pick a plot (a pin and a radius), then show what public
 * records say about it since 2020. The fast findings come first; the
 * Sentinel-2 comparison with early 2020 follows when it is ready. The URL
 * carries the plot so a check can be shared or opened from its PDF.
 */
export function LandCheck({ styleUrl, initial }: Props) {
  const t = useTranslations("land");
  const tr = useTranslations("report");
  const tm = useTranslations("map");
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(initial ? { lat: initial.lat, lon: initial.lon } : null);
  const [radius, setRadius] = useState<number>(initial?.r ?? 100);
  const [query, setQuery] = useState<{ lat: number; lon: number; r: number } | null>(initial);

  const qs = query ? `lat=${query.lat}&lon=${query.lon}&r=${query.r}` : null;
  const opts = { revalidateOnFocus: false, shouldRetryOnError: false };
  const { data: summary, error: summaryError, isLoading } = useSWR<LandSummary>(qs ? `/api/v1/land-check?${qs}` : null, fetcher, opts);
  const { data: change, error: changeError } = useSWR<LandChange>(qs ? `/api/v1/land-check/change?${qs}` : null, fetcher, opts);

  // Keep the address bar in step with the plot being shown.
  useEffect(() => {
    if (!query) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?lat=${query.lat}&lon=${query.lon}&r=${query.r}`);
  }, [query]);

  const run = () => {
    if (!pin) return toast.error(t("pinFirst"));
    setQuery({ lat: Number(pin.lat.toFixed(5)), lon: Number(pin.lon.toFixed(5)), r: radius });
  };

  const locate = () => {
    if (!navigator.geolocation) return toast.error(tm("locationUnavailable"));
    navigator.geolocation.getCurrentPosition(
      (p) => setPin({ lat: Number(p.coords.latitude.toFixed(5)), lon: Number(p.coords.longitude.toFixed(5)) }),
      (err) => toast.error(err.code === err.PERMISSION_DENIED ? tm("locationDenied") : tm("locationUnavailable")),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success(t("copied"));
    } catch {
      toast.message(window.location.href);
    }
  };

  const items = summary ? findings(summary, change ?? null) : [];
  const changePending = Boolean(summary && !change && !changeError);

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <section aria-labelledby="land-pick" className="space-y-4">
        <h2 id="land-pick" className="text-lg font-semibold">
          {t("pickHeading")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("pickHelp")}</p>
        <PinPicker
          value={pin}
          radiusM={radius}
          onChange={setPin}
          styleUrl={styleUrl}
          labels={{ map: tr("pinMap"), satellite: tr("pinSatellite"), hint: tr("pinHint"), ariaLabel: t("pickHeading") }}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button type="button" variant="outline" size="sm" onClick={locate}>
            <LocateFixed className="size-4" aria-hidden />
            {t("useLocation")}
          </Button>
          {pin && (
            <span className="tabular-nums text-muted-foreground">
              {pin.lat.toFixed(5)}, {pin.lon.toFixed(5)}
            </span>
          )}
        </div>
        <fieldset>
          <legend className="text-sm font-medium">{t("radius")}</legend>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup">
            {LAND_RADII.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={radius === r}
                onClick={() => setRadius(r)}
                className={cn("rounded-full border px-3 py-1.5 text-sm hover:bg-accent/60", radius === r && "border-primary bg-accent font-medium")}
              >
                {r < 1000 ? `${r} m` : "1 km"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("radiusOption", { r: radius })}, {t("radiusArea", { ha: ((Math.PI * radius * radius) / 10_000).toFixed(radius < 100 ? 2 : 1) })}
          </p>
        </fieldset>
        <Button size="lg" className="w-full" onClick={run} disabled={isLoading}>
          <Search className="size-4" aria-hidden />
          {isLoading ? t("running") : t("run")}
        </Button>
      </section>

      <section aria-labelledby="land-result" aria-live="polite" className="min-w-0">
        {!query && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p>{t("intro")}</p>
          </div>
        )}
        {query && isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="aspect-[3/1] w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        {summaryError && <p className="rounded-md border p-4 text-sm">{String((summaryError as Error).message)}</p>}
        {summary && query && (
          <div className="space-y-6">
            <header>
              <h2 id="land-result" className="text-xl font-semibold">
                {t("resultHeading")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("plotLine", { r: summary.plot.radiusM, ha: ha(summary.plot.areaHa), lat: summary.plot.lat.toFixed(5), lon: summary.plot.lon.toFixed(5) })}
                {summary.place.district ? ` · ${[summary.place.district, summary.place.region].filter(Boolean).join(", ")}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild>
                  <a href={`/api/v1/land-check/pdf?${qs}`} download>
                    <Download className="size-4" aria-hidden />
                    {t("downloadPdf")}
                  </a>
                </Button>
                <Button variant="outline" asChild>
                  <Link href={groundViewHref(summary.plot.lat, summary.plot.lon, summary.detectionsOnPlot[0]?.id)}>
                    <Rotate3d className="size-4" aria-hidden />
                    {t("groundView")}
                  </Link>
                </Button>
                <Button variant="ghost" onClick={share}>
                  <Share2 className="size-4" aria-hidden />
                  {t("share")}
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t("pdfHelp")}</p>
            </header>

            <figure>
              <figcaption className="sr-only">{t("pictures")}</figcaption>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(["before", "after", "closeup"] as const).map((layer) => (
                  <LandPicture key={`${qs}-${layer}`} src={`/api/v1/land-check/image?${qs}&layer=${layer}`} caption={captionFor(summary, layer)} />
                ))}
              </div>
            </figure>

            {changePending && (
              <p className="flex items-center gap-2 rounded-md border bg-accent/40 p-3 text-sm">
                <span className="size-3 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
                {t("changeRunning")}
              </p>
            )}
            {changeError && <p className="rounded-md border p-3 text-sm text-muted-foreground">{t("changeFailed")}</p>}

            <dl className="divide-y rounded-lg border">
              {items.map((f) => (
                <div key={f.label} className="grid gap-1 p-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                  <dt className="text-sm font-semibold">{f.label}</dt>
                  <dd className="text-sm">
                    <p>{f.value}</p>
                    {f.source && <p className="mt-0.5 text-xs text-muted-foreground">{f.source}</p>}
                  </dd>
                </div>
              ))}
            </dl>

            <aside className="flex gap-2 rounded-md border border-sev-elevated/30 bg-sev-elevated-tint/50 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-sev-elevated" aria-hidden />
              <div>
                <p className="font-medium">{t("limitsHeading")}</p>
                <p className="mt-0.5 text-foreground/90">{t("limits")}</p>
              </div>
            </aside>
          </div>
        )}
      </section>
    </div>
  );
}

function captionFor(s: LandSummary, layer: "before" | "after" | "closeup"): string {
  if (layer === "closeup") {
    if (!s.closeUp) return "No close-up published";
    const what = [s.closeUp.provider, s.closeUp.sensor, s.closeUp.resolutionM ? `${s.closeUp.resolutionM} m` : null].filter(Boolean).join(" ");
    return `Close-up${s.closeUp.capturedOn ? `, ${new Date(`${s.closeUp.capturedOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}` : ""}${what ? ` · ${what}` : ""}`;
  }
  const year = layer === "before" ? s.mosaicYears?.first : s.mosaicYears?.latest;
  return year ? `${year} · cloud-free view (Sentinel-2 cloudless by EOX)` : "Yearly view unavailable";
}

function LandPicture({ src, caption }: { src: string; caption: string }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div className="relative aspect-square bg-muted">
        {state !== "failed" && (
          // eslint-disable-next-line @next/next/no-img-element -- rendered by our land-check image route
          <img
            src={src}
            alt={caption}
            onLoad={() => setState("ok")}
            onError={() => setState("failed")}
            className={cn("h-full w-full object-cover transition-opacity", state === "ok" ? "opacity-100" : "opacity-0")}
          />
        )}
        {state === "loading" && <Skeleton className="absolute inset-0 rounded-none" />}
        {state === "failed" && <p className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted-foreground">{caption}</p>}
      </div>
      <p className="px-2 py-1.5 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}
