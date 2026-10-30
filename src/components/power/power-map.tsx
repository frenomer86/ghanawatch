"use client";

import { AttributionControl, Map as MLMap, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { GHANA_BBOX } from "@/lib/domain/types";

type Point = { lat: number; lon: number; off: number; on: number; last: string; lastKind: "off" | "on" };

/** Live map of power-cut reports in the last 24 hours, refreshed every minute. Red: lights off; green: back. */
export function PowerMap({ styleUrl }: { styleUrl: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!el.current) return;
    // The map worker is served by the site itself (the content security policy allows no blob workers from elsewhere).
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const m = new MLMap({
      container: el.current,
      style: styleUrl,
      bounds: [
        [GHANA_BBOX[0], GHANA_BBOX[1]],
        [GHANA_BBOX[2], GHANA_BBOX[3]],
      ],
      attributionControl: false,
      dragRotate: false,
    });
    map.current = m;
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new AttributionControl({ compact: true }), "bottom-right");
    m.once("style.load", () => {
      m.addSource("power", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "power",
        type: "circle",
        source: "power",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "n"], 1, 6, 10, 14, 50, 22],
          "circle-color": ["match", ["get", "kind"], "off", "#c0392b", "#2e8b57"],
          "circle-opacity": 0.8,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
      });
      load();
    });
    const load = async () => {
      try {
        const res = await fetch("/api/v1/power?hours=24");
        const data = (await res.json()) as { points: Point[] };
        const fc: FeatureCollection = {
          type: "FeatureCollection",
          features: data.points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { kind: p.lastKind, n: p.off + p.on } })),
        };
        (m.getSource("power") as GeoJSONSource | undefined)?.setData(fc);
        setCount(data.points.reduce((a, p) => a + p.off + p.on, 0));
      } catch {
        // Keep the last picture; the next refresh tries again.
      }
    };
    const t = setInterval(load, 60_000);
    return () => {
      clearInterval(t);
      m.remove();
    };
  }, [styleUrl]);

  return (
    <div>
      <div ref={el} className="h-[24rem] w-full overflow-hidden rounded-xl border" aria-label="Map of power-cut reports in the last 24 hours" role="img" />
      <p className="mt-2 text-xs text-muted-foreground">
        {count == null ? "Loading reports…" : count === 0 ? "No power-cut reports in the last 24 hours yet." : `${count} reports in the last 24 hours.`} Red: lights off. Green:
        lights back. Updated every minute.
      </p>
    </div>
  );
}
