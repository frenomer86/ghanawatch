"use client";

import {
  AttributionControl,
  FullscreenControl,
  Map as MLMap,
  Marker,
  NavigationControl,
  ScaleControl,
  TerrainControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type ImageSource,
  type LayerSpecification,
  type RasterTileSource,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { FeatureCollection, Geometry } from "geojson";
import {
  ESRI_ATTRIBUTION,
  MOSAIC_ATTRIBUTION,
  OSM_GLYPHS,
  OSM_TILEJSON,
  TERRAIN_ATTRIBUTION,
  TERRAIN_TILES,
  annualMosaicTiles,
  type NearbyPlace,
  type PassFrame,
} from "@/lib/explore/imagery";
import { SIGHTING_COLORS } from "./sighting-colors";
import { foldAttribution } from "./fold-attribution";

export type FilmFrame =
  | { kind: "mosaic"; key: string; year: number; date: string }
  | { kind: "pass"; key: string; date: string; url: string; corners: PassFrame["corners"] };

export interface ExploreMapHandle {
  resetView: () => void;
  flyTo: (lon: number, lat: number) => void;
}

export interface MapPlace extends NearbyPlace {
  label: string;
}

export interface MapSighting {
  lon: number;
  lat: number;
  kind: string;
  label: string;
}

interface Props {
  center: { lon: number; lat: number };
  hiresTiles: string;
  /** Deepest tile level the selected close-up has. */
  hiresMaxZoom: number;
  mode: "photo" | "film";
  annualYears: number[];
  frame: FilmFrame | null;
  outline: Geometry | null;
  places: MapPlace[];
  sightings: MapSighting[];
  labels: boolean;
  orbit: boolean;
  onOrbitChange: (on: boolean) => void;
  ariaLabel: string;
}

const EXAGGERATION = 1.5;
const OVERVIEW_ZOOM = 12.6;
const CLOSE_ZOOM = 16.2;
/** The film's 10 m imagery reads better from a little higher up. */
const FILM_ZOOM = 14.8;
const CLOSE_PITCH = 68;
/** Degrees of bearing per millisecond while orbiting: one turn in two minutes. */
const ORBIT_SPEED = 0.003;

const PLACE_COLORS: Record<string, string> = {
  school: "#2f6f9f",
  cemetery: "#5c6a63",
  health: "#c0392b",
  worship: "#1f6f50",
};

const OSM_LAYERS = ["osm-roads", "osm-road-names", "osm-water-names", "osm-places"];
/** Everything we add for the film and the detection sits under the labels. */
const BELOW_LABELS = "osm-roads";

function style(hiresTiles: string, hiresMaxZoom: number): StyleSpecification {
  const name: ExpressionSpecification = ["coalesce", ["get", "name:latin"], ["get", "name"]];
  return {
    version: 8,
    glyphs: OSM_GLYPHS,
    sources: {
      hires: { type: "raster", tiles: [hiresTiles], tileSize: 256, maxzoom: hiresMaxZoom, attribution: ESRI_ATTRIBUTION },
      dem: { type: "raster-dem", tiles: [TERRAIN_TILES], tileSize: 256, maxzoom: 14, encoding: "terrarium", attribution: TERRAIN_ATTRIBUTION },
      osm: { type: "vector", url: OSM_TILEJSON },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#0b2e23" } },
      { id: "hires", type: "raster", source: "hires", paint: { "raster-fade-duration": 250 } },
      {
        id: "osm-roads",
        type: "line",
        source: "osm",
        "source-layer": "transportation",
        minzoom: 12,
        filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "track"]]],
        paint: {
          "line-color": "rgba(255,255,255,0.5)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 16, 1.6, 18, 3.5],
        },
      },
      {
        id: "osm-road-names",
        type: "symbol",
        source: "osm",
        "source-layer": "transportation_name",
        minzoom: 14,
        layout: { "symbol-placement": "line", "text-field": name, "text-font": ["Noto Sans Regular"], "text-size": 12 },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.75)", "text-halo-width": 1.4 },
      },
      {
        id: "osm-water-names",
        type: "symbol",
        source: "osm",
        "source-layer": "water_name",
        layout: { "text-field": name, "text-font": ["Noto Sans Italic"], "text-size": 13 },
        paint: { "text-color": "#cfe6ff", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.4 },
      },
      {
        id: "osm-places",
        type: "symbol",
        source: "osm",
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter"]]],
        layout: {
          "text-field": name,
          "text-font": ["Noto Sans Bold"],
          "text-size": ["match", ["get", "class"], "city", 18, "town", 16, "village", 14, 12],
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.8)", "text-halo-width": 1.6 },
      },
    ],
    terrain: { source: "dem", exaggeration: EXAGGERATION },
    sky: {
      "sky-color": "#9ec8ea",
      "horizon-color": "#eef3f6",
      "fog-color": "#e3ebe6",
      "fog-ground-blend": 0.4,
      "horizon-fog-blend": 0.6,
      "sky-horizon-blend": 0.7,
      "atmosphere-blend": 0.5,
    },
  };
}

const emptyFC: FeatureCollection = { type: "FeatureCollection", features: [] };

function placesFC(places: MapPlace[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: places
      .filter((p) => p.kind !== "settlement") // settlements are already named by the OpenStreetMap label layer
      .map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { kind: p.kind, label: p.label } })),
  };
}

function sightingsFC(list: MapSighting[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { kind: s.kind, label: s.label } })),
  };
}

function outlineFC(g: Geometry | null): FeatureCollection {
  return g ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: g, properties: {} }] } : emptyFC;
}

function squareFC(corners: PassFrame["corners"]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [...corners, corners[0]] }, properties: {} }],
  };
}

/**
 * The 3D viewer behind Ground view: dated high-resolution imagery draped over
 * terrain, an optional satellite film (yearly cloud-free mosaics and single
 * recent passes) crossfading on top, the detection outline, nearby mapped
 * places and OpenStreetMap labels. It flies in from above when it opens and
 * then slowly circles the spot until the user takes over.
 */
export const ExploreMap = forwardRef<ExploreMapHandle, Props>(function ExploreMap(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loaded = useRef(false);
  const arrived = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  const target = () => ({ center: [props.center.lon, props.center.lat] as [number, number], zoom: CLOSE_ZOOM, pitch: CLOSE_PITCH, bearing: 30 });

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const p = latest.current;
    const map = new MLMap({
      container: container.current,
      style: style(p.hiresTiles, p.hiresMaxZoom),
      center: [p.center.lon, p.center.lat],
      zoom: OVERVIEW_ZOOM,
      pitch: 0,
      maxPitch: 78,
      minZoom: 6,
      maxZoom: 19,
      attributionControl: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    mapRef.current = map;
    (window as unknown as { __gwExplore?: MLMap }).__gwExplore = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new FullscreenControl(), "top-right");
    map.addControl(new TerrainControl({ source: "dem", exaggeration: EXAGGERATION }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");

    const el = document.createElement("div");
    el.className = "gw-spot";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<span class="gw-spot-pulse"></span><span class="gw-spot-dot"></span>';
    new Marker({ element: el, anchor: "center" }).setLngLat([p.center.lon, p.center.lat]).addTo(map);

    map.once("style.load", () => {
      map.addSource("event", { type: "geojson", data: outlineFC(latest.current.outline) });
      map.addSource("places", { type: "geojson", data: placesFC(latest.current.places) });
      map.addSource("pass-square", { type: "geojson", data: emptyFC });
      map.addSource("sightings", { type: "geojson", data: sightingsFC(latest.current.sightings) });
      map.addLayer({ id: "event-fill", type: "fill", source: "event", paint: { "fill-color": "#ffd400", "fill-opacity": 0.14 } }, BELOW_LABELS);
      map.addLayer(
        { id: "event-line", type: "line", source: "event", paint: { "line-color": "#ffd400", "line-width": 2.5, "line-dasharray": [2, 1.5] } },
        BELOW_LABELS,
      );
      map.addLayer({
        id: "places-dot",
        type: "circle",
        source: "places",
        paint: {
          "circle-radius": 6,
          "circle-color": ["match", ["get", "kind"], "school", PLACE_COLORS.school, "cemetery", PLACE_COLORS.cemetery, "health", PLACE_COLORS.health, PLACE_COLORS.worship],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "places-label",
        type: "symbol",
        source: "places",
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 12 },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.6 },
      });
      // Machinery people tagged on the close-ups, each labelled with the capture date it was seen on.
      map.addLayer({
        id: "sightings-ring",
        type: "circle",
        source: "sightings",
        paint: {
          "circle-radius": 9,
          "circle-color": "rgba(0,0,0,0.25)",
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
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.3], "text-anchor": "top" },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.6 },
      });
      loaded.current = true;
      applyLabels(map, latest.current.labels);
      applyFilm(map, latest.current);

      // Fly in from above. Non-essential, so MapLibre turns it into a jump for reduced-motion users.
      map.once("idle", () => {
        // Credits start folded behind the (i) button so they do not cover the controls.
        foldAttribution(container.current);
        map.flyTo({ ...target(), duration: 6500, curve: 1.25, essential: false });
        map.once("moveend", () => {
          arrived.current = true;
        });
      });
    });

    map.on("error", (e) => console.error("[explore-map]", e.error?.message ?? e));

    // Any direct interaction hands control to the user.
    const stop = () => latest.current.onOrbitChange(false);
    const canvas = map.getCanvasContainer();
    canvas.addEventListener("pointerdown", stop);
    canvas.addEventListener("wheel", stop, { passive: true });
    canvas.addEventListener("keydown", stop);

    return () => {
      canvas.removeEventListener("pointerdown", stop);
      canvas.removeEventListener("wheel", stop);
      canvas.removeEventListener("keydown", stop);
      map.remove();
      mapRef.current = null;
      loaded.current = false;
    };
    // Created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slow orbit around the spot once the fly-in has finished. The centre is set on every
  // frame: with terrain on, rotating alone lets the centre creep along the ground.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.orbit) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const spot: [number, number] = [props.center.lon, props.center.lat];
    const c = map.getCenter();
    const offM = Math.hypot((c.lng - spot[0]) * 111_320 * Math.cos((spot[1] * Math.PI) / 180), (c.lat - spot[1]) * 110_540);
    if (arrived.current && offM > 30) map.easeTo({ center: spot, duration: 1200, essential: false });
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      if (arrived.current && !map.isMoving()) map.jumpTo({ center: spot, bearing: (map.getBearing() + dt * ORBIT_SPEED) % 360 });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.orbit]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const src = map.getSource("hires") as RasterTileSource | undefined;
    if (src && src.maxzoom === props.hiresMaxZoom) {
      src.setTiles([props.hiresTiles]);
      return;
    }
    // A capture with a different depth needs a new source; keep the layer where it was.
    const layers = map.getStyle().layers;
    const above = layers[layers.findIndex((l) => l.id === "hires") + 1]?.id;
    map.removeLayer("hires");
    map.removeSource("hires");
    map.addSource("hires", { type: "raster", tiles: [props.hiresTiles], tileSize: 256, maxzoom: props.hiresMaxZoom, attribution: ESRI_ATTRIBUTION });
    map.addLayer({ id: "hires", type: "raster", source: "hires", paint: { "raster-fade-duration": 250 } }, above);
  }, [props.hiresTiles, props.hiresMaxZoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    applyFilm(map, latest.current);
  }, [props.mode, props.frame, props.annualYears]);

  // Rise a little for the film, come back down for the close-up.
  const firstMode = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    if (!map || !arrived.current) return;
    map.easeTo({
      center: [props.center.lon, props.center.lat],
      zoom: props.mode === "film" ? FILM_ZOOM : CLOSE_ZOOM,
      pitch: props.mode === "film" ? 60 : CLOSE_PITCH,
      duration: 1400,
      essential: false,
    });
    // The spot never changes for a mounted viewer; only the mode matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("event") as GeoJSONSource | undefined)?.setData(outlineFC(props.outline));
  }, [props.outline]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("places") as GeoJSONSource | undefined)?.setData(placesFC(props.places));
  }, [props.places]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    applyLabels(map, props.labels);
  }, [props.labels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("sightings") as GeoJSONSource | undefined)?.setData(sightingsFC(props.sightings));
  }, [props.sightings]);

  useImperativeHandle(ref, () => ({
    resetView: () => {
      arrived.current = false;
      mapRef.current?.flyTo({ ...target(), duration: 2500, essential: false });
      mapRef.current?.once("moveend", () => (arrived.current = true));
    },
    flyTo: (lon, lat) => {
      latest.current.onOrbitChange(false);
      mapRef.current?.flyTo({ center: [lon, lat], zoom: 16.8, pitch: 62, duration: 2500, essential: false });
    },
  }));

  return <div ref={container} className="gw-explore h-full w-full bg-[#0b2e23]" role="region" aria-label={props.ariaLabel} />;
});

function applyLabels(map: MLMap, on: boolean) {
  for (const id of OSM_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/** Show the close-up, or the film frame: a yearly mosaic, or a single pass drawn over the latest mosaic. */
function applyFilm(map: MLMap, p: Props) {
  const film = p.mode === "film" && p.frame;
  // Mosaic layers are added once, all visible while the film is on so their tiles preload, and crossfaded by opacity.
  for (const year of p.annualYears) {
    const id = `mosaic-${year}`;
    if (!map.getSource(id)) {
      map.addSource(id, { type: "raster", tiles: [annualMosaicTiles(year)], tileSize: 256, maxzoom: 15, attribution: MOSAIC_ATTRIBUTION });
      const layer: LayerSpecification = {
        id,
        type: "raster",
        source: id,
        layout: { visibility: "none" },
        paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 450, delay: 0 }, "raster-fade-duration": 0 },
      };
      map.addLayer(layer, map.getLayer("pass") ? "pass" : "event-fill");
    }
  }
  const lastYear = p.annualYears[p.annualYears.length - 1];
  const shownYear = !film ? null : p.frame!.kind === "mosaic" ? p.frame!.year : lastYear;
  for (const year of p.annualYears) {
    const id = `mosaic-${year}`;
    map.setLayoutProperty(id, "visibility", film ? "visible" : "none");
    map.setPaintProperty(id, "raster-opacity", year === shownYear ? 1 : 0);
  }

  const pass = film && p.frame!.kind === "pass" ? p.frame! : null;
  if (pass && pass.kind === "pass") {
    const src = map.getSource("pass") as ImageSource | undefined;
    if (!src) {
      map.addSource("pass", { type: "image", url: pass.url, coordinates: pass.corners });
      map.addLayer({ id: "pass", type: "raster", source: "pass", paint: { "raster-fade-duration": 0 } }, "event-fill");
      map.addLayer(
        { id: "pass-square", type: "line", source: "pass-square", paint: { "line-color": "#ffffff", "line-width": 1.5, "line-opacity": 0.8 } },
        "event-fill",
      );
    } else {
      src.updateImage({ url: pass.url, coordinates: pass.corners });
    }
    (map.getSource("pass-square") as GeoJSONSource | undefined)?.setData(squareFC(pass.corners));
    map.setLayoutProperty("pass", "visibility", "visible");
    map.setLayoutProperty("pass-square", "visibility", "visible");
  } else if (map.getLayer("pass")) {
    map.setLayoutProperty("pass", "visibility", "none");
    map.setLayoutProperty("pass-square", "visibility", "none");
  }
}
