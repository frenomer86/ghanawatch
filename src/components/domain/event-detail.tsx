"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, BookmarkCheck, ChevronRight, Download, ExternalLink, MapPin, Rotate3d, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import type { ChangeEventDetail } from "@/lib/domain/types";
import { formatHectares } from "@/lib/domain/format";
import { groundViewHref } from "@/lib/explore/imagery";
import { useWatchlist } from "@/lib/client/watchlist";
import { Button } from "@/components/ui/button";
import { SeverityBadge } from "./severity-badge";
import { TypeIcon } from "./type-icon";
import { DateStamp } from "./date-stamp";
import { SatelliteViews } from "./satellite-views";
import { cn } from "@/lib/utils";

const fmtLength = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

/**
 * Full detection record. Used inside the map rail, the mobile sheet and the
 * stand-alone /event/[id] page so the three never drift apart.
 */
export function EventDetail({ event, className, showOpenFull = false }: { event: ChangeEventDetail; className?: string; showOpenFull?: boolean }) {
  const t = useTranslations("event");
  const tx = useTranslations("explore");
  const tType = useTranslations("type");
  const tConf = useTranslations("confidence");
  const { add, remove, has, ready } = useWatchlist();
  const watchId = `pt:${event.centroid.lon.toFixed(3)},${event.centroid.lat.toFixed(3)}`;
  const watching = ready && has(watchId);
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const url = `${window.location.origin}/event/${event.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: event.title, url });
        return;
      }
    } catch {
      /* user cancelled */
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(url);
    }
  };

  const place = [event.districtName, event.regionName].filter(Boolean).join(", ");

  return (
    <article className={cn("space-y-5", className)} aria-labelledby={`event-title-${event.id}`}>
      <header>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <TypeIcon type={event.type} className="size-4" />
          <span>{tType(event.type)}</span>
          <SeverityBadge severity={event.severity} size="sm" />
          <span className="rounded-full border px-2 py-0.5 text-xs">{tConf(event.confidence)}</span>
        </div>
        <h2 id={`event-title-${event.id}`} className="mt-2 text-xl font-semibold leading-tight">
          {event.title}
        </h2>
        <p className="mt-1 text-muted-foreground">{place}</p>
        <DateStamp imageDate={event.imageDate} imageDateEnd={event.imageDateEnd} detectedAt={event.detectedAt} className="mt-3 flex-col items-start gap-y-0.5" />
      </header>

      <section aria-label={t("image")} className="overflow-hidden rounded-lg border">
        <SatelliteViews event={event} />
      </section>

      <Link
        href={groundViewHref(event.centroid.lat, event.centroid.lon, event.id)}
        className="group flex items-center gap-3 rounded-lg border border-primary/25 bg-accent/50 p-3 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <Rotate3d className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{tx("groundView")}</span>
          <span className="block text-sm text-muted-foreground">{tx("groundViewHint")}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>

      {event.flags.length > 0 && (
        <section className="rounded-lg border border-sev-elevated/30 bg-sev-elevated-tint/60 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-sev-elevated">
            <MapPin className="size-4" aria-hidden />
            Where it is
          </h3>
          <ul className="mt-1.5 space-y-0.5 text-sm text-foreground/90">
            {event.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted-foreground">From OpenStreetMap; distances are to the mapped point and approximate.</p>
        </section>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {event.track ? (
          <div>
            <dt className="text-muted-foreground">{t("trackLength")}</dt>
            <dd className="font-medium tabular-nums">{t("trackSize", { length: fmtLength(event.track.lengthM), width: event.track.widthM })}</dd>
          </div>
        ) : (
          <div>
            <dt className="text-muted-foreground">{t("area")}</dt>
            <dd className="font-medium tabular-nums">{formatHectares(event.areaHa)}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">{tConf("label")}</dt>
          <dd className="font-medium">{tConf(event.confidence)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("source")}</dt>
          <dd className="font-medium">
            <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-link underline">
              {event.sourceName}
            </a>
          </dd>
        </div>
      </dl>

      <section>
        <h3 className="text-sm font-medium">{t("whatThisMeans")}</h3>
        <p className="mt-1 text-sm text-foreground/90">{event.description}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t("limitations")}</p>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={watching ? "secondary" : "default"}
          onClick={() =>
            watching
              ? remove(watchId)
              : add({ id: watchId, kind: "point", name: place || event.title, lon: event.centroid.lon, lat: event.centroid.lat, radiusKm: 10 })
          }
          aria-pressed={watching}
        >
          {watching ? <BookmarkCheck className="size-4" aria-hidden /> : <Bookmark className="size-4" aria-hidden />}
          {watching ? t("unwatch") : t("watchThisArea")}
        </Button>
        <Button variant="outline" onClick={share} aria-live="polite">
          <Share2 className="size-4" aria-hidden />
          {copied ? t("copied") : t("share")}
        </Button>
        <Button variant="outline" asChild>
          <a href={`/api/v1/events/${event.id}?format=geojson`} download={`ghanawatch-${event.id}.geojson`}>
            <Download className="size-4" aria-hidden />
            {t("downloadRecord")}
          </a>
        </Button>
        {showOpenFull && (
          <Button variant="ghost" asChild>
            <Link href={`/event/${event.id}`}>
              <ExternalLink className="size-4" aria-hidden />
              {t("openOnMap")}
            </Link>
          </Button>
        )}
      </div>

      <footer className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{t("citation")}</p>
        <p className="mt-1 select-all break-words">{event.citation}</p>
        <p className="mt-2">{event.sourceAttribution}</p>
      </footer>
    </article>
  );
}
