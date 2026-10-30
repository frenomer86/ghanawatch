"use client";

import { AttributionControl, Map as MLMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { GHANA_BBOX } from "@/lib/domain/types";
import { ESRI_ATTRIBUTION, WORLD_IMAGERY_TILES } from "@/lib/explore/imagery";
import { cn } from "@/lib/utils";

interface Props {
  value: { lat: number; lon: number } | null;
  /** Draw a circle of this many metres around the pin (the plot being checked). */
  radiusM?: number;
  onChange: (p: { lat: number; lon: number }) => void;
  styleUrl: string;
  labels: { map: string; satellite: string; hint: string; ariaLabel: string };
  className?: string;
}

const SATELLITE: StyleSpecification = {
  version: 8,
  sources: { sat: { type: "raster", tiles: [WORLD_IMAGERY_TILES], tileSize: 256, maxzoom: 18, attribution: ESRI_ATTRIBUTION } },
  layers: [{ id: "sat", type: "raster", source: "sat" }],
};

/**
 * Pick a point on a small map: click to drop the pin, drag it to adjust.
 * Switches between the street map and satellite imagery so a place can be
 * found by sight. Keyboard users can still type the coordinates beside it.
 */
function circleFC(lon: number, lat: number, r: number): FeatureCollection {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lon + (r * Math.sin(a)) / (111_320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.cos(a)) / 110_574]);
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: {} }] };
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function PinPicker({ value, radiusM, onChange, styleUrl, labels, className }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const circleRef = useRef<FeatureCollection>(EMPTY);
  const [satellite, setSatellite] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const lat = value?.lat;
  const lon = value?.lon;

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const map = new MLMap({
      container: container.current,
      style: styleUrl,
      bounds: [
        [GHANA_BBOX[0], GHANA_BBOX[1]],
        [GHANA_BBOX[2], GHANA_BBOX[3]],
      ],
      maxBounds: [
        [GHANA_BBOX[0] - 2, GHANA_BBOX[1] - 2],
        [GHANA_BBOX[2] + 2, GHANA_BBOX[3] + 2],
      ],
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");
    map.on("click", (e) => onChangeRef.current({ lat: Number(e.lngLat.lat.toFixed(5)), lon: Number(e.lngLat.lng.toFixed(5)) }));
    // The plot circle has to be added again whenever the base style changes.
    map.on("style.load", () => {
      if (map.getSource("plot")) return;
      map.addSource("plot", { type: "geojson", data: circleRef.current });
      map.addLayer({ id: "plot-fill", type: "fill", source: "plot", paint: { "fill-color": "#ffd400", "fill-opacity": 0.15 } });
      map.addLayer({ id: "plot-line", type: "line", source: "plot", paint: { "line-color": "#ffd400", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // The map is created once; the style switch and the pin are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setStyle(satellite ? SATELLITE : styleUrl);
  }, [satellite, styleUrl]);

  useEffect(() => {
    circleRef.current = radiusM && lat != null && lon != null ? circleFC(lon, lat, radiusM) : EMPTY;
    (mapRef.current?.getSource("plot") as GeoJSONSource | undefined)?.setData(circleRef.current);
  }, [lat, lon, radiusM]);

  // Keep the pin where the value says, creating it on the first point.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!markerRef.current) {
      markerRef.current = new Marker({ draggable: true, color: "#0f3d2e" }).setLngLat([lon, lat]).addTo(map);
      markerRef.current.on("dragend", () => {
        const p = markerRef.current!.getLngLat();
        onChangeRef.current({ lat: Number(p.lat.toFixed(5)), lon: Number(p.lng.toFixed(5)) });
      });
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });
    } else {
      markerRef.current.setLngLat([lon, lat]);
      if (!map.getBounds().contains([lon, lat])) map.easeTo({ center: [lon, lat], duration: 500 });
    }
  }, [lat, lon]);

  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      <div className="relative h-64">
        <div ref={container} className="h-full w-full" role="region" aria-label={labels.ariaLabel} />
        <div className="absolute left-2 top-2 z-10 flex overflow-hidden rounded-md border bg-card text-xs shadow">
          <button type="button" aria-pressed={!satellite} onClick={() => setSatellite(false)} className={cn("px-2.5 py-1.5", !satellite && "bg-accent font-medium")}>
            {labels.map}
          </button>
          <button type="button" aria-pressed={satellite} onClick={() => setSatellite(true)} className={cn("border-l px-2.5 py-1.5", satellite && "bg-accent font-medium")}>
            {labels.satellite}
          </button>
        </div>
      </div>
      <p className="border-t bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{labels.hint}</p>
    </div>
  );
}
