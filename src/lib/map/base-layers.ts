import L from "leaflet";
import { env } from "$env/dynamic/public";
import type { BaseLayerName } from "./layer-preferences";

export function createMapPanes(map: L.Map): void {
  map.createPane("baseMapPane");
  map.getPane("baseMapPane")!.style.zIndex = "100";
  map.createPane("markerOnTop");
  map.getPane("markerOnTop")!.style.zIndex = "980";
  map.createPane("popupOnTop");
  map.getPane("popupOnTop")!.style.zIndex = "990";
}

export type TileLayerFactory = (dir: string, style: string) => L.TileLayer;

export function createTileLayerFactory(
  exportsCdn: string,
  mapWidth: number,
  mapHeight: number,
): { terrainBounds: L.LatLngBounds; createTileLayer: TileLayerFactory } {
  const terrainBounds = L.latLngBounds([
    [0, 0],
    [mapHeight, mapWidth],
  ]);

  function createTileLayer(dir: string, style: string): L.TileLayer {
    const tileLayer = L.tileLayer(
      `${exportsCdn}/${dir}${style ? "/" + style : ""}/tiles/{z}/{x}/{y}.webp`,
      {
        bounds: terrainBounds,
        minZoom: -5,
        maxZoom: 5,
        minNativeZoom: -5,
        maxNativeZoom: 0,
        tileSize: 256,
        keepBuffer: 4,
        updateWhenZooming: false,
        errorTileUrl: "",
        pane: "baseMapPane",
      },
    );
    (tileLayer as any)._isValidTile = function (coords: {
      x: number;
      y: number;
      z: number;
    }) {
      const tileBounds = (this as any)._tileCoordsToBounds(coords);
      return terrainBounds.overlaps(tileBounds);
    };
    return tileLayer;
  }

  return { terrainBounds, createTileLayer };
}

export interface BaseLayers {
  terrainTileLayer?: L.TileLayer;
  gameTileLayer?: L.TileLayer;
}

/** Add the active base layer to the map: CDN tiles when enabled, the bundled image overlay otherwise. */
export function setupBaseLayers(
  map: L.Map,
  createTileLayer: TileLayerFactory,
  terrainBounds: L.LatLngBounds,
  activeBaseLayer: BaseLayerName,
): BaseLayers {
  if (env.PUBLIC_CDN_MAP === "true") {
    const terrainTileLayer = createTileLayer("maps", "terrain");
    const gameTileLayer = createTileLayer("maps", "game");
    if (activeBaseLayer === "terrain") {
      terrainTileLayer.addTo(map);
    } else {
      gameTileLayer.addTo(map);
    }
    return { terrainTileLayer, gameTileLayer };
  }
  L.imageOverlay("/assets/maps/map.webp", terrainBounds, {
    pane: "baseMapPane",
  }).addTo(map);
  return {};
}
