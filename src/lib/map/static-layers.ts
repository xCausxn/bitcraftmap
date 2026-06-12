import L from "leaflet";
import {
  loadTreesGeoJson,
  loadEmpireResourcesGeoJson,
  loadTemplesGeoJson,
  loadNpcsGeoJson,
  loadClaimsGeoJson,
  loadCavesGeoJson,
  loadEventsGeoJson,
  loadUnchartedGeoJson,
  loadDungeonsGeoJson,
  loadGridsGeoJson,
  loadTowersGeoJson,
} from "./geojson-loader";
import type { PaintContext } from "./geojson-painter";
import type { MapLayers } from "./layer-registry";
import { addSearchEntries } from "$lib/stores/search-store.svelte";

/** Register every titled marker in the given layers with the search index. */
function registerMarkerSearchEntries(layers: L.LayerGroup[]): void {
  for (const layer of layers) {
    layer.eachLayer((l) => {
      const marker = l as L.Marker;
      if (marker.options?.title) {
        addSearchEntries([
          {
            title: marker.options.title,
            latlng: marker.getLatLng(),
            layer,
            marker,
            selectionData: (marker as any)._selectionData,
          },
        ]);
      }
    });
  }
}

export function loadStaticGeoJsonLayers(
  layers: MapLayers,
  paintCtx: PaintContext,
  map: L.Map,
): void {
  loadTreesGeoJson(layers.treesLayer);
  loadEmpireResourcesGeoJson(layers.hexiteLayer, layers.makersTreeLayer);
  loadTemplesGeoJson(layers.templesLayer);
  loadNpcsGeoJson(layers.ruinedLayer, layers.travelerCampLayer).then(() => {
    registerMarkerSearchEntries([layers.ruinedLayer, layers.travelerCampLayer]);
  });
  loadCavesGeoJson(layers.caveLayers);
  loadClaimsGeoJson(
    layers.claimLayers,
    layers.banksLayer,
    layers.marketsLayer,
    layers.waystonesLayer,
  ).then(() => {
    registerMarkerSearchEntries(layers.claimLayers);
  });
  loadEventsGeoJson(layers.eventsLayer);
  loadUnchartedGeoJson(layers.geysersLayer, layers.hermitCrabDensLayer);
  loadDungeonsGeoJson(layers.dungeonsLayer);
  loadGridsGeoJson(layers.gridsLayer, paintCtx);
  loadTowersGeoJson(layers.towersLayer, layers.territoriesLayer, map);
}
