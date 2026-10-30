"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Minus, Plus, ScanSearch, Send, X } from "lucide-react";
import { toast } from "sonner";
import { SIGHTING_KINDS, type SightingKind } from "@/lib/domain/types";
import {
  appleMapsSatelliteUrl,
  bingAerialUrl,
  googleEarthUrl,
  googleMapsSatelliteUrl,
  type HighResCapture,
  type Sighting,
} from "@/lib/explore/imagery";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SIGHTING_COLORS } from "./sighting-colors";

interface PanelProps {
  lat: number;
  lon: number;
  captures: HighResCapture[];
  sightings: Sighting[];
  day: (iso: string) => string;
  formatDistance: (m: number) => string;
  onShow: (s: Sighting) => void;
}

/** Right-panel section for Ground view's machinery mode. */
export function MachineryPanel({ lat, lon, captures, sightings, day, formatDistance, onShow }: PanelProps) {
  const t = useTranslations("explore");
  const newest = captures[0];
  const links = [
    { href: googleEarthUrl(lat, lon), label: t("googleEarth") },
    { href: googleMapsSatelliteUrl(lat, lon), label: t("googleMaps") },
    { href: bingAerialUrl(lat, lon), label: t("bingMaps") },
    { href: appleMapsSatelliteUrl(lat, lon), label: t("appleMaps") },
  ];
  return (
    <section aria-labelledby="gv-machinery" className="space-y-5">
      <div>
        <h2 id="gv-machinery" className="flex items-center gap-1.5 text-sm font-semibold">
          <ScanSearch className="size-4 text-muted-foreground" aria-hidden />
          {t("machineryHeading")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("machineryHelp")}</p>
        {newest?.capturedOn && <p className="mt-2 text-sm font-medium">{t("machineryNewest", { date: day(newest.capturedOn) })}</p>}
        {captures.length === 1 && <p className="mt-1 text-sm text-muted-foreground">{t("machineryOnlyOne")}</p>}
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("newerElsewhere")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("newerElsewhereHelp")}</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {links.map((l) => (
            <Button key={l.href} variant="outline" size="sm" className="justify-between" asChild>
              <a href={l.href} target="_blank" rel="noopener noreferrer">
                <span className="truncate">{l.label}</span>
                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              </a>
            </Button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("taggedHeading")}</h3>
        {sightings.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted-foreground">{t("taggedNone")}</p>
        ) : (
          <ul className="mt-2 divide-y rounded-md border">
            {sightings.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span aria-hidden className="size-3 shrink-0 rounded-full border-2" style={{ borderColor: SIGHTING_COLORS[s.kind] }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {t(`sightingKind.${s.kind}`)}
                    {s.count > 1 ? ` ×${s.count}` : ""}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {s.capturedOn ? (s.source === "sentinel-1" ? t("taggedRadar", { date: day(s.capturedOn) }) : t("taggedOn", { date: day(s.capturedOn) })) : ""}
                    {s.distanceM != null ? ` · ${t("away", { distance: formatDistance(s.distanceM) })}` : ""}
                  </span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => onShow(s)}>
                  {t("show")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{t("tagHelp")}</p>
      </div>
    </section>
  );
}

interface TagFormProps {
  draft: { lon: number; lat: number; capture: HighResCapture };
  eventId: string | null;
  day: (iso: string) => string;
  onCancel: () => void;
  onSent: (status: "pending" | "confirmed") => void;
}

/** The small form that appears after clicking a machine on a close-up. */
export function TagForm({ draft, eventId, day, onCancel, onSent }: TagFormProps) {
  const t = useTranslations("explore");
  const [kind, setKind] = useState<SightingKind>("excavator");
  const [count, setCount] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/sightings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lat: Number(draft.lat.toFixed(6)),
          lon: Number(draft.lon.toFixed(6)),
          kind,
          count,
          release: draft.capture.release,
          capturedOn: draft.capture.capturedOn,
          sensor: draft.capture.sensor,
          ...(eventId ? { changeEventId: eventId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const body = (await res.json()) as { status?: "pending" | "confirmed"; message?: string };
      if (!res.ok) {
        toast.error(t("tagFailed", { message: body.message ?? res.statusText }));
        return;
      }
      toast.success(body.status === "confirmed" ? t("tagPublished") : t("tagSent"));
      onSent(body.status ?? "pending");
    } catch {
      toast.error(t("tagFailed", { message: "network" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-labelledby="gv-tag-title" className="w-full max-w-md rounded-lg border bg-card p-3 text-sm shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <p id="gv-tag-title" className="font-semibold">
          {draft.capture.capturedOn ? t("tagFormTitle", { date: day(draft.capture.capturedOn) }) : t("tagFormTitleUnknown")}
        </p>
        <button type="button" className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={t("tagCancel")} onClick={onCancel}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
        {draft.lat.toFixed(6)}, {draft.lon.toFixed(6)}
      </p>
      <fieldset className="mt-2.5">
        <legend className="text-xs font-medium text-muted-foreground">{t("tagKind")}</legend>
        <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup">
          {SIGHTING_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent/60",
                kind === k && "border-primary bg-accent font-medium",
              )}
            >
              <span aria-hidden className="size-2.5 rounded-full border-2" style={{ borderColor: SIGHTING_COLORS[k] }} />
              {t(`sightingKind.${k}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mt-2.5 flex items-center gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{t("tagCount")}</Label>
        <Button variant="outline" size="icon" className="size-7" aria-label={t("tagFewer")} onClick={() => setCount((c) => Math.max(1, c - 1))} disabled={count <= 1}>
          <Minus className="size-3.5" aria-hidden />
        </Button>
        <span className="w-6 text-center tabular-nums" aria-live="polite">
          {count}
        </span>
        <Button variant="outline" size="icon" className="size-7" aria-label={t("tagMore")} onClick={() => setCount((c) => Math.min(50, c + 1))} disabled={count >= 50}>
          <Plus className="size-3.5" aria-hidden />
        </Button>
      </div>
      <Label htmlFor="gv-tag-note" className="mt-2.5 block text-xs font-medium text-muted-foreground">
        {t("tagNote")}
      </Label>
      <Textarea
        id="gv-tag-note"
        rows={2}
        maxLength={280}
        className="mt-1"
        placeholder={t("tagNotePlaceholder")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-2.5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("tagCancel")}
        </Button>
        <Button size="sm" onClick={send} disabled={busy}>
          <Send className="size-4" aria-hidden />
          {t("tagSend")}
        </Button>
      </div>
    </div>
  );
}
