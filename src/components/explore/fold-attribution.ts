/**
 * MapLibre opens the compact credits panel when it first fills; fold it behind
 * its (i) button so it does not cover the picture. The panel is a <details>
 * element, so both the class and the open attribute have to go.
 */
export function foldAttribution(container: HTMLElement | null) {
  const el = container?.querySelector(".maplibregl-ctrl-attrib");
  el?.classList.remove("maplibregl-compact-show");
  el?.removeAttribute("open");
}
