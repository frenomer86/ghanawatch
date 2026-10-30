"use client";

import {
  AttributionControl,
  GeolocateControl,
  Map as MLMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type LayerSpecification,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useImperativeHandle, useRef, forwardRef, useCallback } from "react";
import type { FeatureCollection } from "geojson";
import { GHANA_BBOX, type BBox } from "@/lib/domain/types";
import {
  cellForZoom,
  countLayer,
  districtsFillLayer,
  districtsLineLayer,
  footprintsFillLayer,
  footprintsLineLayer,
  haloLayer,
  hotspotsLayer,
  hotspotsSelectedLayer,
  outlineLayer,
} from "./map-styles";

import type { ViewState } from "./map-params";

export interface MapHandle {
  flyTo: (opts: { lon: number; lat: number; zoom?: number }) => void;
  fitBounds: (b: BBox, padding?: number) => void;
  resetView: () => void;
  getBounds: () => BBox | null;
  getZoom: () => number;
}

export interface HotspotProps {
  key: string;
  type: string;
  severity: string;
  count: number;
  isNew: boolean;
  bbox: BBox;
  district: string | null;
  sampleId: string;
  latestImageDate: string;
}

interface Props {
  styleUrl: string;
  initialView: ViewState;
  showDistricts: boolean;
  /** Places water has covered at some time since 1984: river flood plains, wetlands and lake shores. */
  showFloodProne?: boolean;
  hotspots: FeatureCollection | null;
  footprints: FeatureCollection | null;
  selectedKey: string | null;
  onViewChange: (v: ViewState, bbox: BBox, cell: number) => void;
  onHotspotClick: (p: HotspotProps) => void;
  onFootprintClick: (id: string) => void;
  onHover?: (p: HotspotProps | null, point: { x: number; y: number } | null) => void;
  /** A click on the map away from any detection: the point and where it is on screen. */
  onMapClick?: (p: { lon: number; lat: number; x: number; y: number }) => void;
  onReady?: () => void;
  locateLabel: string;
}

const GHANA_BOUNDS: LngLatBoundsLike = [
  [GHANA_BBOX[0], GHANA_BBOX[1]],
  [GHANA_BBOX[2], GHANA_BBOX[3]],
];

/**
 * Imperative MapLibre wrapper. React owns the data (GeoJSON props) and the
 * view-state callbacks; MapLibre owns rendering. Sources are created once on
 * load and updated with setData so layers never flicker.
 */
export const MapView = forwardRef<MapHandle, Props>(function MapView(
  { styleUrl, initialView, showDistricts, showFloodProne = false, hotspots, footprints, selectedKey, onViewChange, onHotspotClick, onFootprintClick, onHover, onMapClick, onReady, locateLabel },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loaded = useRef(false);
  const cbs = useRef({ onViewChange, onHotspotClick, onFootprintClick, onHover, onMapClick, onReady });
  cbs.current = { onViewChange, onHotspotClick, onFootprintClick, onHover, onMapClick, onReady };
  // Latest data, so whatever arrived before the style finished loading is applied on load.
  const dataRef = useRef({ hotspots, footprints, showDistricts, showFloodProne, selectedKey });
  dataRef.current = { hotspots, footprints, showDistricts, showFloodProne, selectedKey };

  const emitView = useCallback((map: MLMap) => {
    const c = map.getCenter();
    const b = map.getBounds();
    const z = map.getZoom();
    cbs.current.onViewChange(
      { lon: +c.lng.toFixed(4), lat: +c.lat.toFixed(4), zoom: +z.toFixed(2) },
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      cellForZoom(z),
    );
  }, []);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    // The worker is served as a plain static file so it works under any bundler and a strict CSP.
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const map = new MLMap({
      container: container.current,
      style: styleUrl,
      center: [initialView.lon, initialView.lat],
      zoom: initialView.zoom,
      minZoom: 5,
      maxZoom: 16,
      maxBounds: [
        [GHANA_BBOX[0] - 3, GHANA_BBOX[1] - 3],
        [GHANA_BBOX[2] + 3, GHANA_BBOX[3] + 3],
      ],
      attributionControl: false,
      cooperativeGestures: false,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
    });
    mapRef.current = map;
    // Exposed for browser-console inspection and end-to-end tests.
    (window as unknown as { __gwMap?: MLMap }).__gwMap = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new GeolocateControl({ positionOptions: { enableHighAccuracy: false }, fitBoundsOptions: { maxZoom: 11 }, trackUserLocation: false }),
      "top-right",
    );
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");
    map.touchZoomRotate.disableRotation();

    // style.load fires as soon as the style JSON is parsed, before the first frame is drawn,
    // so sources and layers exist even in a background tab where rendering is throttled.
    map.once("style.load", () => {
      map.addSource("gw-outline", { type: "geojson", data: "/boundaries/ghana-outline.geojson" });
      map.addSource("gw-districts", { type: "geojson", data: "/boundaries/ghana-districts.geojson", promoteId: "code" });
      map.addSource("gw-hotspots", { type: "geojson", data: dataRef.current.hotspots ?? emptyFC, promoteId: "key" });
      map.addSource("gw-footprints", { type: "geojson", data: dataRef.current.footprints ?? emptyFC, promoteId: "id" });
      map.addSource("gw-flood-prone", {
        type: "raster",
        tiles: ["https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 13,
        attribution: "Water history: EC JRC/Google",
      });

      // Place our layers under the basemap's labels when the style has them.
      const firstSymbol = (map.getStyle().layers as LayerSpecification[]).find((l) => l.type === "symbol")?.id;
      map.addLayer(
        { id: "gw-flood-prone", type: "raster", source: "gw-flood-prone", paint: { "raster-opacity": 0.55 }, layout: { visibility: dataRef.current.showFloodProne ? "visible" : "none" } },
        firstSymbol,
      );
      map.addLayer(districtsFillLayer, firstSymbol);
      map.addLayer(districtsLineLayer, firstSymbol);
      map.addLayer(outlineLayer, firstSymbol);
      map.addLayer(footprintsFillLayer);
      map.addLayer(footprintsLineLayer);
      map.addLayer(haloLayer);
      map.addLayer(hotspotsLayer);
      map.addLayer(hotspotsSelectedLayer);
      map.addLayer(countLayer);
      map.setLayoutProperty("gw-districts-line", "visibility", dataRef.current.showDistricts ? "visible" : "none");
      map.setFilter("gw-hotspots-selected", ["==", ["get", "key"], dataRef.current.selectedKey ?? ""]);

      const locateBtn = container.current?.querySelector(".maplibregl-ctrl-geolocate");
      locateBtn?.setAttribute("aria-label", locateLabel);
      locateBtn?.setAttribute("title", locateLabel);

      loaded.current = true;
      emitView(map);
      cbs.current.onReady?.();
    });

    map.on("moveend", () => emitView(map));
    map.on("error", (e) => console.error("[map]", e.error?.message ?? e));

    const toProps = (f: MapGeoJSONFeature): HotspotProps => {
      const p = f.properties as Record<string, unknown>;
      let bbox = p.bbox as unknown;
      if (typeof bbox === "string") {
        try {
          bbox = JSON.parse(bbox);
        } catch {
          bbox = GHANA_BBOX;
        }
      }
      return {
        key: String(p.key),
        type: String(p.type),
        severity: String(p.severity),
        count: Number(p.count),
        isNew: p.isNew === true || p.isNew === "true",
        bbox: bbox as BBox,
        district: (p.district as string | null) ?? null,
        sampleId: String(p.sampleId),
        latestImageDate: String(p.latestImageDate),
      };
    };

    map.on("click", "gw-hotspots", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const f = e.features?.[0];
      if (f) cbs.current.onHotspotClick(toProps(f));
    });
    map.on("click", "gw-footprints-fill", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const f = e.features?.[0];
      if (f && f.id != null) cbs.current.onFootprintClick(String(f.id));
    });
    map.on("click", (e: MapMouseEvent) => {
      const layers = ["gw-hotspots", "gw-footprints-fill"].filter((l) => map.getLayer(l));
      if (map.queryRenderedFeatures(e.point, { layers }).length) return;
      cbs.current.onMapClick?.({ lon: e.lngLat.lng, lat: e.lngLat.lat, x: e.point.x, y: e.point.y });
    });
    for (const layer of ["gw-hotspots", "gw-footprints-fill"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        cbs.current.onHover?.(null, null);
      });
    }
    map.on("mousemove", "gw-hotspots", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const f = e.features?.[0];
      if (f) cbs.current.onHover?.(toProps(f), { x: e.point.x, y: e.point.y });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      loaded.current = false;
    };
    // The map is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("gw-hotspots") as GeoJSONSource | undefined)?.setData(hotspots ?? emptyFC);
  }, [hotspots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("gw-footprints") as GeoJSONSource | undefined)?.setData(footprints ?? emptyFC);
  }, [footprints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    map.setLayoutProperty("gw-districts-line", "visibility", showDistricts ? "visible" : "none");
  }, [showDistricts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    map.setLayoutProperty("gw-flood-prone", "visibility", showFloodProne ? "visible" : "none");
  }, [showFloodProne]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    map.setFilter("gw-hotspots-selected", ["==", ["get", "key"], selectedKey ?? ""]);
  }, [selectedKey]);

  useImperativeHandle(ref, () => ({
    flyTo: ({ lon, lat, zoom }) => mapRef.current?.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(mapRef.current.getZoom(), 10), duration: 700 }),
    fitBounds: (b, padding = 48) =>
      mapRef.current?.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding, duration: 700, maxZoom: 13 },
      ),
    resetView: () => mapRef.current?.fitBounds(GHANA_BOUNDS, { padding: 24, duration: 700 }),
    getBounds: () => {
      const b = mapRef.current?.getBounds();
      return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
    },
    getZoom: () => mapRef.current?.getZoom() ?? initialView.zoom,
  }));

  // h-full rather than absolute: maplibre-gl.css sets .maplibregl-map to position: relative.
  return <div ref={container} className="gw-national-map h-full w-full bg-paper-deep" role="region" aria-label="Map of Ghana" />;
});

const emptyFC: FeatureCollection = { type: "FeatureCollection", features: [] };
