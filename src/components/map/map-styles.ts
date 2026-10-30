import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";

/**
 * Layer definitions for the national map. The basemap is deliberately muted;
 * detections are the only saturated colour. Severity drives fill colour,
 * count drives size, "new in the last 72 hours" adds a halo.
 */

export const SEVERITY_COLOR: ExpressionSpecification = [
  "match",
  ["get", "severity"],
  "urgent",
  "#d13b3b",
  "elevated",
  "#e4731f",
  "watch",
  "#e2a92b",
  // Inside a mapped licensed mine: grey, so it never reads as galamsey.
  "licensed",
  "#8a9490",
  "#2e8b57",
];

const RADIUS: ExpressionSpecification = ["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 7, 3, 11, 10, 17, 30, 24, 100, 32];

export const outlineLayer: LayerSpecification = {
  id: "gw-outline",
  type: "line",
  source: "gw-outline",
  paint: { "line-color": "#0f3d2e", "line-width": 1.6, "line-opacity": 0.75 },
};

export const districtsLineLayer: LayerSpecification = {
  id: "gw-districts-line",
  type: "line",
  source: "gw-districts",
  paint: { "line-color": "#5c6a63", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.3, 10, 0.9], "line-opacity": 0.55 },
};

export const districtsFillLayer: LayerSpecification = {
  id: "gw-districts-fill",
  type: "fill",
  source: "gw-districts",
  paint: { "fill-color": "#1f6f50", "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.08, 0] },
};

export const footprintsFillLayer: LayerSpecification = {
  id: "gw-footprints-fill",
  type: "fill",
  source: "gw-footprints",
  minzoom: 10,
  paint: { "fill-color": SEVERITY_COLOR, "fill-opacity": 0.28 },
};

export const footprintsLineLayer: LayerSpecification = {
  id: "gw-footprints-line",
  type: "line",
  source: "gw-footprints",
  minzoom: 10,
  paint: { "line-color": SEVERITY_COLOR, "line-width": 1.5 },
};

export const haloLayer: LayerSpecification = {
  id: "gw-hotspots-halo",
  type: "circle",
  source: "gw-hotspots",
  filter: ["==", ["get", "isNew"], true],
  paint: {
    "circle-radius": ["+", RADIUS, 7],
    "circle-color": SEVERITY_COLOR,
    "circle-opacity": 0.22,
    "circle-stroke-width": 0,
  },
};

export const hotspotsLayer: LayerSpecification = {
  id: "gw-hotspots",
  type: "circle",
  source: "gw-hotspots",
  paint: {
    "circle-radius": RADIUS,
    "circle-color": SEVERITY_COLOR,
    "circle-opacity": 0.92,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.5,
  },
};

export const hotspotsSelectedLayer: LayerSpecification = {
  id: "gw-hotspots-selected",
  type: "circle",
  source: "gw-hotspots",
  filter: ["==", ["get", "key"], ""],
  paint: {
    "circle-radius": ["+", RADIUS, 4],
    "circle-color": "rgba(0,0,0,0)",
    "circle-stroke-color": "#0f3d2e",
    "circle-stroke-width": 2.5,
  },
};

export const countLayer: LayerSpecification = {
  id: "gw-hotspots-count",
  type: "symbol",
  source: "gw-hotspots",
  filter: [">", ["get", "count"], 1],
  layout: {
    "text-field": ["to-string", ["get", "count"]],
    "text-size": 12,
    "text-font": ["Noto Sans Bold"],
    "text-allow-overlap": true,
  },
  paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.25)", "text-halo-width": 0.6 },
};

/** Grid cell size in degrees for a given zoom: finer cells as the user zooms in. */
export function cellForZoom(zoom: number): number {
  if (zoom < 6.5) return 0.2;
  if (zoom < 8) return 0.1;
  if (zoom < 9.5) return 0.05;
  if (zoom < 11) return 0.02;
  return 0.008;
}
