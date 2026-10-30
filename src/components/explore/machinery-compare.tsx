"use client";

import { AttributionControl, Map as MLMap, Marker, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { FeatureCollection, Geometry } from "geojson";
import { ESRI_ATTRIBUTION, OSM_GLYPHS, maxTileZoom, waybackTiles, type HighResCapture, type Sighting } from "@/lib/explore/imagery";
import { cn } from "@/lib/utils";
import { SIGHTING_COLORS } from "./sighting-colors";
import { foldAttribution } from "./fold-attribution";

interface Props {
  center: { lon: number; lat: number };
  captures: HighResCapture[];
  sightings: Sighting[];
  outline: Geometry | null;
  tagging: boolean;
  draft: { lon: number; lat: number; release: number } | null;
  focus: { lon: number; lat: number; key: number } | null;
  onPick: (p: { lon: number; lat: number; capture: HighResCapture }) => void;
  paneTitle: (c: HighResCapture, newest: boolean) => { title: string; sub: string };
  sightingLabel: (s: Sighting) => string;
  ariaLabel: (c: HighResCapture) => string;
  newestLabel: string;
}

/** What the maps' event handlers need at the moment of the event, kept current by an effect. */
interface Live {
  tagging: boolean;
  following: boolean;
  onPick: Props["onPick"];
}

const START_ZOOM = 17.6;

function outlineFC(g: Geometry | null): FeatureCollection {
  return g ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: g, properties: {} }] } : { type: "FeatureCollection", features: [] };
}

function sightingsFC(list: Sighting[], label: (s: Sighting) => string): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { kind: s.kind, label: label(s) } })),
  };
}

/**
 * The same spot in every dated close-up we can show, side by side and moving
 * together, for spotting excavators, trucks and washing plants. Top-down and
 * flat: machines are easiest to recognise from straight above. When tagging is
 * on, a click marks the machine on that particular capture.
 */
export function MachineryCompare(props: Props) {
  const panes = props.captures;
  const maps = useRef(new Map<number, MLMap>());
  const syncing = useRef(false);
  const live = useRef<Live>({ tagging: props.tagging, following: false, onPick: props.onPick });

  useEffect(() => {
    live.current = { tagging: props.tagging, following: Boolean(props.focus), onPick: props.onPick };
  });

  // Exposed for browser-console inspection and end-to-end tests, like the other maps.
  useEffect(() => {
    (window as unknown as { __gwPanes?: Map<number, MLMap> }).__gwPanes = maps.current;
  }, []);

  // Keep every pane on the same camera as the one being moved.
  const sync = (from: MLMap) => {
    if (syncing.current) return;
    syncing.current = true;
    const cam = { center: from.getCenter(), zoom: from.getZoom(), bearing: from.getBearing(), pitch: 0 };
    for (const m of maps.current.values()) if (m !== from) m.jumpTo(cam);
    syncing.current = false;
  };

  useEffect(() => {
    const m = [...maps.current.values()][0];
    if (props.focus && m) m.easeTo({ center: [props.focus.lon, props.focus.lat], zoom: Math.max(m.getZoom(), 18), duration: 800 });
  }, [props.focus]);

  useEffect(() => {
    for (const m of maps.current.values()) m.getCanvas().style.cursor = props.tagging ? "crosshair" : "";
  }, [props.tagging]);

  useEffect(() => {
    for (const [release, m] of maps.current) {
      (m.getSource("sightings") as GeoJSONSource | undefined)?.setData(sightingsFC(props.sightings.filter((s) => s.release === release), props.sightingLabel));
    }
  }, [props.sightings, props.sightingLabel]);

  return (
    <div className={cn("grid h-full w-full gap-px bg-black", panes.length > 1 && "grid-cols-1 sm:grid-cols-2", panes.length > 2 && "sm:grid-rows-2")}>
      {panes.map((c, i) => (
        <Pane
          key={c.release}
          // With three captures the newest gets the whole left column.
          className={panes.length === 3 && i === 0 ? "sm:row-span-2" : undefined}
          capture={c}
          index={i}
          head={props.paneTitle(c, i === 0)}
          ariaLabel={props.ariaLabel(c)}
          newestLabel={props.newestLabel}
          draft={props.draft && props.draft.release === c.release ? props.draft : null}
          outline={props.outline}
          sightings={props.sightings.filter((s) => s.release === c.release)}
          sightingLabel={props.sightingLabel}
          live={live}
          register={(m) => {
            if (m) maps.current.set(c.release, m);
            else maps.current.delete(c.release);
          }}
          onMove={sync}
          initialCamera={() => {
            const first = [...maps.current.values()][0];
            return first
              ? { center: first.getCenter(), zoom: first.getZoom(), bearing: first.getBearing() }
              : { center: { lng: props.center.lon, lat: props.center.lat }, zoom: START_ZOOM, bearing: 0 };
          }}
        />
      ))}
    </div>
  );
}

interface PaneProps {
  className?: string;
  capture: HighResCapture;
  index: number;
  head: { title: string; sub: string };
  ariaLabel: string;
  newestLabel: string;
  draft: { lon: number; lat: number } | null;
  outline: Geometry | null;
  sightings: Sighting[];
  sightingLabel: (s: Sighting) => string;
  live: React.RefObject<Live>;
  register: (m: MLMap | null) => void;
  onMove: (m: MLMap) => void;
  initialCamera: () => { center: { lng: number; lat: number }; zoom: number; bearing: number };
}

function Pane({ className, capture, index, head, ariaLabel, newestLabel, draft, outline, sightings, sightingLabel, live, register, onMove, initialCamera }: PaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const draftMarker = useRef<Marker | null>(null);

  useEffect(() => {
    if (!container.current) return;
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const cam = initialCamera();
    const map = new MLMap({
      container: container.current,
      style: {
        version: 8,
        glyphs: OSM_GLYPHS,
        sources: { hires: { type: "raster", tiles: [waybackTiles(capture.release)], tileSize: 256, maxzoom: maxTileZoom(capture), attribution: ESRI_ATTRIBUTION } },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#0b2e23" } },
          { id: "hires", type: "raster", source: "hires" },
        ],
      },
      center: [cam.center.lng, cam.center.lat],
      zoom: cam.zoom,
      bearing: cam.bearing,
      maxZoom: 20,
      minZoom: 12,
      pitchWithRotate: false,
      maxPitch: 0,
      attributionControl: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    mapRef.current = map;
    register(map);
    if (index === 0) {
      map.addControl(new NavigationControl({ showCompass: true }), "top-right");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    }
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");
    map.touchPitch.disable();

    map.once("style.load", () => {
      map.addSource("event", { type: "geojson", data: outlineFC(outline) });
      map.addSource("sightings", { type: "geojson", data: sightingsFC(sightings, sightingLabel) });
      map.addLayer({ id: "event-line", type: "line", source: "event", paint: { "line-color": "#ffd400", "line-width": 2, "line-dasharray": [2, 1.5] } });
      map.addLayer({
        id: "sightings-ring",
        type: "circle",
        source: "sightings",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 6, 19, 16],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 3,
          "circle-stroke-color": [
            "match",
            ["get", "kind"],
            "excavator",
            SIGHTING_COLORS.excavator,
            "truck",
            SIGHTING_COLORS.truck,
            "washing_plant",
            SIGHTING_COLORS.washing_plant,
            "dredger",
            SIGHTING_COLORS.dredger,
            SIGHTING_COLORS.other,
          ],
        },
      });
      map.addLayer({
        id: "sightings-label",
        type: "symbol",
        source: "sightings",
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.6], "text-anchor": "top" },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.6 },
      });
    });
    map.once("idle", () => foldAttribution(container.current));

    map.on("move", (e) => {
      // User moves (and a "show this tag" glide) are mirrored live; mirrored jumps carry no original event.
      if ((e as { originalEvent?: unknown }).originalEvent || live.current.following) onMove(map);
    });
    map.on("moveend", () => onMove(map));
    map.on("click", (e) => {
      if (live.current.tagging) live.current.onPick({ lon: e.lngLat.lng, lat: e.lngLat.lat, capture });
    });

    return () => {
      register(null);
      map.remove();
      mapRef.current = null;
    };
    // One map per capture; later changes arrive through the parent's effects and the draft effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.release]);

  // The tag being placed, on the capture it was placed on.
  const draftLon = draft?.lon;
  const draftLat = draft?.lat;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    draftMarker.current?.remove();
    draftMarker.current = null;
    if (draftLon != null && draftLat != null) {
      const el = document.createElement("div");
      el.className = "gw-spot";
      el.innerHTML = '<span class="gw-spot-pulse"></span><span class="gw-spot-dot"></span>';
      draftMarker.current = new Marker({ element: el }).setLngLat([draftLon, draftLat]).addTo(map);
    }
  }, [draftLon, draftLat]);

  return (
    <div className={cn("relative min-h-[220px]", className)}>
      <div ref={container} className="h-full w-full" role="region" aria-label={ariaLabel} />
      <div className="pointer-events-none absolute left-2 top-2 z-10 rounded-md bg-black/70 px-2.5 py-1.5 text-white shadow">
        <p className="flex items-center gap-2 text-sm font-semibold leading-tight">
          {head.title}
          {index === 0 && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">{newestLabel}</span>}
        </p>
        <p className="text-[11px] text-white/80">{head.sub}</p>
      </div>
    </div>
  );
}
