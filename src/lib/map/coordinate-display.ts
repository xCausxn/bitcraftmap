import type L from "leaflet";
import { formatCoordinates } from "./coordinate-utils";

/**
 * Wire mouse/touch handlers that report the cursor (or map center on touch)
 * coordinates plus zoom level. Updates are throttled to ~10fps via rAF.
 */
export function setupCoordinateDisplay(
  map: L.Map,
  onChange: (text: string) => void,
): void {
  let current = "";
  function update(text: string): void {
    current = text;
    onChange(text);
  }

  let hasTouch = false;
  let mouseMoveRaf = false;
  map.on("mousemove", (e: L.LeafletMouseEvent) => {
    if (mouseMoveRaf) return;
    mouseMoveRaf = true;
    requestAnimationFrame(() => {
      mouseMoveRaf = false;
      update(`${formatCoordinates(e.latlng)} Zoom: ${map.getZoom().toFixed(1)}`);
    });
  });
  map.getContainer().addEventListener(
    "touchstart",
    () => {
      hasTouch = true;
    },
    { once: true },
  );
  map.on("move", () => {
    if (hasTouch)
      update(
        `${formatCoordinates(map.getCenter())} Zoom: ${map.getZoom().toFixed(1)}`,
      );
  });
  map.on("zoomend", () => {
    update(
      current.replace(/Zoom: -?[\d.]+/, `Zoom: ${map.getZoom().toFixed(1)}`),
    );
  });
}
