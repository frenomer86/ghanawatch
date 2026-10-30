"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Camera, CheckCircle2, LocateFixed, ShieldCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { GHANA_BBOX, REPORT_CATEGORIES, type ReportCategory } from "@/lib/domain/types";
import { cn } from "@/lib/utils";
import { PHOTO_MAX_BYTES, PHOTO_MIME } from "@/lib/domain/validation";
import { enqueueReport, flushQueue } from "@/lib/client/report-queue";

type Status = "idle" | "sending" | "sent" | "queued" | "error";

const PinPicker = dynamic(() => import("@/components/map/pin-picker").then((m) => m.PinPicker), {
  ssr: false,
  loading: () => <div className="h-[17.5rem] animate-pulse rounded-md border bg-muted" />,
});

/**
 * Ground report form (FR-15). What it is, a photo, the location and a short
 * text; anonymous; validated on submit; queued in IndexedDB when offline and
 * flushed on reconnect. After sending, the reporter gets the link to follow
 * their report's public case trail.
 */
export function ReportForm({ styleUrl }: { styleUrl: string }) {
  const t = useTranslations("report");
  const tm = useTranslations("map");
  const id = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [consent, setConsent] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    flushQueue().catch(() => undefined);
    const onOnline = () => flushQueue().then((n) => n > 0 && toast.success(t("sent"))).catch(() => undefined);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [t]);

  const locate = () => {
    if (!navigator.geolocation) return toast.error(tm("locationUnavailable"));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(5));
        setLon(p.coords.longitude.toFixed(5));
        setAccuracy(Math.round(p.coords.accuracy));
      },
      (err) => toast.error(err.code === err.PERMISSION_DENIED ? tm("locationDenied") : tm("locationUnavailable")),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!category) e.category = "Choose what you are reporting.";
    const file = fileRef.current?.files?.[0];
    if (!file) e.photo = "Add a photo.";
    else if (!(PHOTO_MIME as readonly string[]).includes(file.type)) e.photo = "Use a JPEG, PNG or WebP photo.";
    else if (file.size > PHOTO_MAX_BYTES) e.photo = "The photo is larger than 5 MB.";
    else if (file.size === 0) e.photo = "The photo file is empty.";
    const la = Number(lat);
    const lo = Number(lon);
    if (!lat || !lon || !Number.isFinite(la) || !Number.isFinite(lo)) e.location = "Add a location.";
    else if (la < GHANA_BBOX[1] || la > GHANA_BBOX[3] || lo < GHANA_BBOX[0] || lo > GHANA_BBOX[2]) e.location = "The location must be inside Ghana.";
    if (!desc.trim()) e.description = "Describe what you saw.";
    else if (desc.length > 500) e.description = "Keep the description under 500 characters.";
    if (!consent) e.consent = "Confirm the statement to send the report.";
    return e;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setStatus("sending");
    const fd = new FormData();
    fd.set("photo", fileRef.current!.files![0]);
    fd.set("lat", lat);
    fd.set("lon", lon);
    if (accuracy != null) fd.set("accuracyM", String(accuracy));
    fd.set("description", desc.trim());
    fd.set("category", category!);
    try {
      const res = await fetch("/api/v1/reports", { method: "POST", body: fd });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        setStatus("sent");
        setSentId(body.id ?? null);
        toast.success(t("sent"));
        reset();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setStatus("error");
      toast.error(body.message ?? t("failed"));
    } catch {
      await enqueueReport({ photo: fileRef.current!.files![0], lat, lon, accuracyM: accuracy, description: desc.trim(), category: category! });
      setStatus("queued");
      toast(t("queued"));
      reset();
    }
  };

  const reset = () => {
    setDesc("");
    setCategory(null);
    setConsent(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const errorList = Object.entries(errors);

  if (status === "sent" && sentId) {
    return (
      <section className="mt-8 rounded-lg border border-primary/30 bg-accent/50 p-5" aria-live="polite">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
          {t("sentTitle")}
        </h2>
        <p className="mt-2 text-sm">{t("sentBody")}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/reports/${sentId}`}>{t("sentCaseLink")}</Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSentId(null);
              setStatus("idle");
            }}
          >
            {t("another")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mt-8 space-y-7" aria-describedby={errorList.length ? `${id}-summary` : undefined}>
      <p className="flex gap-2 rounded-md border bg-card p-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>{t("anonymous")}</span>
      </p>
      {errorList.length > 0 && (
        <div ref={summaryRef} id={`${id}-summary`} tabIndex={-1} role="alert" className="rounded-md border border-sev-urgent/40 bg-sev-urgent-tint p-3 text-sm text-sev-urgent">
          <p className="font-medium">Fix the following to send your report:</p>
          <ul className="mt-1 list-disc pl-5">
            {errorList.map(([k, v]) => (
              <li key={k}>
                <a href={`#${id}-${k}`} className="underline">
                  {v}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="space-y-2" id={`${id}-category`}>
        <legend className="text-sm font-medium">{t("categoryLabel")}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-invalid={Boolean(errors.category)}>
          {REPORT_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "rounded-full border px-3.5 py-2 text-sm transition-colors hover:bg-accent/60",
                category === c && "border-primary bg-accent font-medium",
              )}
            >
              {t(`category.${c}`)}
            </button>
          ))}
        </div>
        {errors.category && <p className="text-sm text-sev-urgent">{errors.category}</p>}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={`${id}-photo`}>{t("photo")}</Label>
        <Input
          ref={fileRef}
          id={`${id}-photo`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          aria-describedby={`${id}-photo-help${errors.photo ? ` ${id}-photo-err` : ""}`}
          aria-invalid={Boolean(errors.photo)}
          className="h-11 file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
        />
        <p id={`${id}-photo-help`} className="text-xs text-muted-foreground">
          {t("photoHelp")}
        </p>
        {errors.photo && (
          <p id={`${id}-photo-err`} className="text-sm text-sev-urgent">
            {errors.photo}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("location")}</legend>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <Label htmlFor={`${id}-lat`} className="text-xs text-muted-foreground">
              Latitude
            </Label>
            <Input id={`${id}-lat`} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} aria-invalid={Boolean(errors.location)} className="h-11" />
          </div>
          <div className="flex-1">
            <Label htmlFor={`${id}-lon`} className="text-xs text-muted-foreground">
              Longitude
            </Label>
            <Input id={`${id}-lon`} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} aria-invalid={Boolean(errors.location)} className="h-11" />
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" onClick={locate} className="h-11 w-full sm:w-auto">
              <LocateFixed className="size-4" aria-hidden />
              {tm("nearMe")}
            </Button>
          </div>
        </div>
        <PinPicker
          value={lat && lon && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) ? { lat: Number(lat), lon: Number(lon) } : null}
          onChange={(p) => {
            setLat(p.lat.toFixed(5));
            setLon(p.lon.toFixed(5));
            setAccuracy(null);
          }}
          styleUrl={styleUrl}
          labels={{ map: t("pinMap"), satellite: t("pinSatellite"), hint: t("pinHint"), ariaLabel: t("pinAria") }}
        />
        <p className="text-xs text-muted-foreground">
          {t("locationHelp")}
          {accuracy != null ? ` (±${accuracy} m)` : ""}
        </p>
        {errors.location && (
          <p id={`${id}-location`} className="text-sm text-sev-urgent">
            {errors.location}
          </p>
        )}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={`${id}-description`}>{t("description")}</Label>
        <Textarea
          id={`${id}-description`}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          maxLength={500}
          rows={4}
          aria-describedby={`${id}-description-help`}
          aria-invalid={Boolean(errors.description)}
        />
        <p id={`${id}-description-help`} className="flex justify-between text-xs text-muted-foreground">
          <span>{t("descriptionHelp")}</span>
          <span className="tabular-nums">{desc.length}/500</span>
        </p>
        {errors.description && <p className="text-sm text-sev-urgent">{errors.description}</p>}
      </div>

      <div className="flex items-start gap-3">
        <Checkbox id={`${id}-consent`} checked={consent} onCheckedChange={(v) => setConsent(v === true)} aria-invalid={Boolean(errors.consent)} className="mt-0.5" />
        <Label htmlFor={`${id}-consent`} className="text-sm leading-snug">
          {t("consent")}
        </Label>
      </div>
      {errors.consent && <p className="text-sm text-sev-urgent">{errors.consent}</p>}

      <Button type="submit" size="lg" disabled={status === "sending"} className="w-full sm:w-auto">
        <Camera className="size-4" aria-hidden />
        {status === "sending" ? t("sending") : t("submit")}
      </Button>
      <p className="sr-only" aria-live="polite">
        {status === "sent" ? t("sent") : status === "queued" ? t("queued") : ""}
      </p>
    </form>
  );
}
