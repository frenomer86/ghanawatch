"use client";

import { useState } from "react";
import { useFormatter } from "next-intl";
import type { ChangeEventDetail } from "@/lib/domain/types";

/**
 * Real satellite imagery for a detection, from NASA GIBS (keyless public
 * imagery service, the same one behind NASA Worldview). VIIRS true colour,
 * one global image per day at 375 m: coarse, but genuine and dated. Shows the
 * image date and the same view one week earlier for comparison.
 */
const LAYER = "VIIRS_NOAA20_CorrectedReflectance_TrueColor";
const HALF_DEG = 0.25; // about 55 km across

function snapshotUrl(date: string, lon: number, lat: number) {
  const bbox = [lat - HALF_DEG, lon - HALF_DEG, lat + HALF_DEG, lon + HALF_DEG].map((v) => v.toFixed(4)).join(",");
  const p = new URLSearchParams({
    REQUEST: "GetSnapshot",
    LAYERS: LAYER,
    CRS: "EPSG:4326",
    TIME: date,
    WRAP: "day",
    BBOX: bbox,
    FORMAT: "image/jpeg",
    WIDTH: "480",
    HEIGHT: "480",
  });
  return `https://wvs.earthdata.nasa.gov/api/v1/snapshot?${p.toString()}`;
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function SatelliteViews({ event }: { event: ChangeEventDetail }) {
  const f = useFormatter();
  const fmt = (iso: string) => f.dateTime(new Date(iso), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const s2After = event.images.find((i) => i.role === "latest" && i.thumbnailUrl);
  const s2Before = event.images.find((i) => i.role === "before" && i.thumbnailUrl);
  if (s2After) {
    const views = [
      ...(s2Before ? [{ label: "Before", img: s2Before }] : []),
      { label: "After", img: s2After },
    ];
    return (
      <figure>
        <div className={`grid gap-px bg-border ${views.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
          {views.map((v) => (
            <SatView
              key={v.label}
              label={v.label}
              date={v.img.acquiredAt.slice(0, 10)}
              dateText={fmt(v.img.acquiredAt)}
              src={v.img.thumbnailUrl!}
              severity={event.severity}
              marker={false}
            />
          ))}
        </div>
        <figcaption className="border-t px-3 py-2 text-xs text-muted-foreground">
          {s2After.sensor?.includes("Sentinel-1")
            ? "Radar image, which sees through cloud: open water shows black. The dashed yellow line on the after image outlines the new water. Contains modified Copernicus Sentinel data."
            : "True colour, 10 m. The dashed yellow line on the after image outlines the detected change. Contains modified Copernicus Sentinel data."}
        </figcaption>
      </figure>
    );
  }
  const { lon, lat } = event.centroid;
  const after = event.imageDateEnd ?? event.imageDate;
  const before = shiftDate(event.imageDate, -7);
  const views = [
    { label: "Before", date: before },
    { label: "Seen by satellite", date: after },
  ];
  return (
    <figure>
      <div className="grid grid-cols-2 gap-px bg-border">
        {views.map((v) => (
          <SatView key={v.date} label={v.label} date={v.date} dateText={f.dateTime(new Date(`${v.date}T00:00:00Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} src={snapshotUrl(v.date, lon, lat)} severity={event.severity} />
        ))}
      </div>
      <figcaption className="border-t px-3 py-2 text-xs text-muted-foreground">
        True colour, about 55 km across, centred on the detection (NASA). Cloud may hide the ground; a fire is usually too small to see at
        this scale.
      </figcaption>
    </figure>
  );
}

function SatView({ label, date, dateText, src, severity, marker = true }: { label: string; date: string; dateText: string; src: string; severity: string; marker?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-square bg-paper-deep">
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element -- external imagery service, sized by the service
        <img
          src={src}
          alt={`Satellite image of the area on ${dateText}`}
          width={480}
          height={480}
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
      {failed && <p className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted-foreground">No image available for {dateText}.</p>}
      <span className="absolute left-2 top-2 rounded bg-card/90 px-1.5 py-0.5 text-xs font-medium">
        {label} <time dateTime={date}>{dateText}</time>
      </span>
      {marker && <span aria-hidden className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ borderColor: `var(--sev-${severity}-fill)`, boxShadow: "0 0 0 1px #fff" }} />}
    </div>
  );
}
