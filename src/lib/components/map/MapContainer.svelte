<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { onMount, setContext } from "svelte";
  import L from "leaflet";
  import "leaflet/dist/leaflet.css";
  import { createMapConfig } from "$lib/config/map";
  import { createAppConfig } from "$lib/config/api";
  import { setupDefaultIcon } from "$lib/map/create-icon";
  import { initIcons, loadGeoJsonFromHash } from "$lib/map/geojson-loader";
  import { validateGeoJson } from "$lib/map/geojson-validator";
  import { paintGeoJson, type PaintContext } from "$lib/map/geojson-painter";
  import {
    createMapPanes,
    createTileLayerFactory,
    setupBaseLayers,
  } from "$lib/map/base-layers";
  import { createMapLayers, type MapLayers } from "$lib/map/layer-registry";
  import { loadStaticGeoJsonLayers } from "$lib/map/static-layers";
  import { setupCoordinateDisplay } from "$lib/map/coordinate-display";
  import { PlayerTracking } from "$lib/map/player-tracking";
  import { ResourceTracking } from "$lib/map/resource-tracking";
  import {
    DEFAULT_LAYERS,
    loadBaseLayerPreference,
    saveBaseLayerPreference,
    loadActiveLayerNames,
    saveActiveLayerNames,
    type BaseLayerName,
  } from "$lib/map/layer-preferences";
  import { getLodEnabled } from "$lib/stores/settings-store.svelte";
  import {
    setMap,
    saveMapState,
    restoreMapState,
    hashHasFlyToOrZoom,
    resetView,
  } from "$lib/stores/map-store";
  import {
    buildChatCoordinateLink,
    buildCoordinateViewUrl,
  } from "$lib/utils/coordinate-links";
  import { parseUrlParams, updateRegionIdParam } from "$lib/utils/url-params";
  import { getRegionState, setRegions } from "$lib/stores/region-store.svelte";
  import { registerColorSyncHandler } from "$lib/stores/tracking-store.svelte";
  import { getLatestGistRaw } from "$lib/services/gist-service";
  import {
    setResourceEventCallback,
    closeResourceWebSocket,
  } from "$lib/services/websocket-service";
  import {
    handleResourceEvent,
    cancelAllPendingRefetches,
    type ResourceUpdateContext,
  } from "$lib/services/resource-update-handler";
  import { setSelection } from "$lib/stores/selection-store.svelte";
  import { addLayerEntries } from "$lib/stores/search-store.svelte";

  import CoordinateDisplay from "./CoordinateDisplay.svelte";
  import ResetViewButton from "./ResetViewButton.svelte";
  import GameTimers from "./GameTimers.svelte";
  import SearchBar from "$lib/components/search/SearchBar.svelte";
  import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
  import DetailPanel from "$lib/components/detail/DetailPanel.svelte";

  function showPopupCopyFeedback(btn: HTMLElement): void {
    const originalIcon = btn.dataset.icon ?? btn.textContent ?? "";
    btn.classList.add("is-copied");
    btn.textContent = "✓";
    btn.title = "Copied!";
    window.setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.textContent = originalIcon;
      const action = btn.dataset.action;
      btn.title = action === "copy-chat-coords"
        ? "Copy in-game chat link to coordinates"
        : "Copy website link to coordinates";
    }, 1200);
  }

  let mapElement: HTMLDivElement;
  let map = $state<L.Map>(undefined!);
  let mapReady = $state(false);
  let coords = $state("N: 0 E: 0");
  const regionState = getRegionState();

  let terrainTileLayer: L.TileLayer | undefined;
  let gameTileLayer: L.TileLayer | undefined;
  let layers: MapLayers;
  let liveLayer: L.FeatureGroup;

  let playerTracking: PlayerTracking;
  let resourceTracking: ResourceTracking;

  // Toggle mapping for layer panel
  let genericToggle = $state<Record<string, L.LayerGroup>>({});
  let activeLayers = new SvelteSet<string>();
  let activeBaseLayer = $state<BaseLayerName>("terrain");

  // Propagate LOD setting to all resource layers whenever it changes
  $effect(() => {
    const enabled = getLodEnabled();
    resourceTracking?.setLodEnabled(enabled);
  });

  const resourceUpdateCtx: ResourceUpdateContext = {
    get resourceLayers() {
      return resourceTracking.resourceLayers;
    },
    getActiveRegions: () => regionState.effectiveRegions,
  };

  // Context for child components
  let paintCtx: PaintContext;
  const mapConfig = createMapConfig();

  onMount(() => {
    const appConfig = createAppConfig();
    const urlParams = parseUrlParams();

    // Seed region store from URL if present (URL takes priority over localStorage)
    if (urlParams.regionId) {
      const urlRegions = urlParams.regionId
        .split(",")
        .map(Number)
        .filter((n) => n > 0);
      if (urlRegions.length > 0) {
        setRegions(urlRegions);
      }
    }

    // Initialize map
    map = L.map(mapElement, mapConfig);
    setupDefaultIcon();
    initIcons();
    createMapPanes(map);

    const { terrainBounds, createTileLayer } = createTileLayerFactory(
      appConfig.exportsCdn,
      mapConfig.mapWidth,
      mapConfig.mapHeight,
    );

    activeBaseLayer = loadBaseLayerPreference();
    ({ terrainTileLayer, gameTileLayer } = setupBaseLayers(
      map,
      createTileLayer,
      terrainBounds,
      activeBaseLayer,
    ));
    map.fitBounds([
      [0, 0],
      [mapConfig.mapWidth, mapConfig.mapHeight],
    ]);
    setMap(map);

    // Create all layer groups
    layers = createMapLayers(createTileLayer("roads", ""));
    genericToggle = layers.genericToggle;

    // Live tracking layer
    liveLayer = L.featureGroup().addTo(map);

    playerTracking = new PlayerTracking(map, liveLayer);
    resourceTracking = new ResourceTracking(
      map,
      () => regionState.effectiveRegions,
    );

    addLayerEntries(
      Object.entries(genericToggle).map(([title, layer]) => ({
        title,
        layer,
        type: "layer" as const,
      })),
    );

    paintCtx = { map, allLayers: layers.allLayers };

    // Restore saved layers or use defaults
    const saved = loadActiveLayerNames();
    const layersToActivate = saved ?? DEFAULT_LAYERS;
    for (const name of layersToActivate) {
      const layer = genericToggle[name];
      if (layer) {
        layer.addTo(map);
        activeLayers.add(name);
      }
    }

    setupCoordinateDisplay(map, (text) => {
      coords = text;
    });

    // Handle action buttons inside Leaflet popups
    map.on("popupopen", (e: L.PopupEvent) => {
      const container = e.popup.getElement();
      if (!container) return;
      container.addEventListener("click", handlePopupClick);
    });

    // Map state persistence
    map.on("moveend", () => saveMapState(map));

    // Load GeoJSON data
    loadStaticGeoJsonLayers(layers, paintCtx, map);

    // Load from hash / gist / backend
    loadGeoJsonFromHash(layers.waypointsLayer, paintCtx, map);

    if (urlParams.gistId) {
      getLatestGistRaw(urlParams.gistId)
        .then((content) => {
          const geoJson = validateGeoJson(content);
          paintGeoJson(geoJson, layers.waypointsLayer, paintCtx);
          map.addLayer(layers.waypointsLayer);
        })
        .catch(console.error);
    }

    // Backend resource/enemy loading
    resourceTracking
      .loadFromUrl(urlParams.resourceId, urlParams.enemyId, urlParams.noColors)
      .catch(console.error);

    // WebSocket player tracking from URL params
    if (urlParams.playerId) {
      playerTracking.trackFromUrl(urlParams.playerId, urlParams.followPlayer);
    }

    // Restore map state
    if (urlParams.center) {
      const [n, e] = urlParams.center;
      const zoom = Math.min(
        Math.max(urlParams.zoom ?? map.getZoom(), map.getMinZoom()),
        map.getMaxZoom(),
      );
      map.flyTo([n * 3, e * 3], zoom);
    } else if (!hashHasFlyToOrZoom()) {
      restoreMapState(map);
    }

    mapReady = true;

    // Wire up resource WebSocket event handler
    setResourceEventCallback((event) => {
      handleResourceEvent(event, resourceUpdateCtx);
    });

    const unregisterColorSync = registerColorSyncHandler((type, id, color) => {
      if (type === "player") {
        playerTracking.setMarkerColor(id as string, color);
      } else {
        resourceTracking.setColor(id as number, color);
      }
    });

    return () => {
      unregisterColorSync();
      playerTracking.dispose();
      closeResourceWebSocket();
      cancelAllPendingRefetches();
      map.remove();
    };
  });

  function handlePopupClick(ev: MouseEvent) {
    const btn = (ev.target as HTMLElement).closest(
      "[data-action]",
    ) as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "track-resource") {
      const id = Number(btn.dataset.resourceId);
      const name = btn.dataset.resourceName ?? "";
      const tier = Number(btn.dataset.resourceTier);
      if (id) handleResourceSelect(id, name, tier);
      map.closePopup();
    } else if (action === "follow-player") {
      const entityId = btn.dataset.entityId ?? "";
      if (entityId) playerTracking.toggleFollow(entityId);
      map.closePopup();
    } else if (action === "copy-view-coords") {
      const n = Number(btn.dataset.n);
      const e = Number(btn.dataset.e);
      const z = Number(btn.dataset.z);
      if (
        !Number.isFinite(n) ||
        !Number.isFinite(e) ||
        !Number.isFinite(z) ||
        !navigator.clipboard
      )
        return;
      navigator.clipboard
        .writeText(buildCoordinateViewUrl({ n, e, z }))
        .then(() => showPopupCopyFeedback(btn));
    } else if (action === "copy-chat-coords") {
      const n = Number(btn.dataset.n);
      const e = Number(btn.dataset.e);
      if (!Number.isFinite(n) || !Number.isFinite(e) || !navigator.clipboard)
        return;
      navigator.clipboard
        .writeText(buildChatCoordinateLink({ n, e }))
        .then(() => showPopupCopyFeedback(btn));
    }
  }

  function handlePlayerSelect(
    entityId: string,
    username: string,
  ): Promise<void> {
    return playerTracking.track(entityId, username);
  }

  function handleResourceSelect(
    resourceId: number,
    name: string,
    tier: number,
  ): Promise<void> {
    return resourceTracking.trackResource(resourceId, name, tier);
  }

  function handleCreatureSelect(
    enemyId: number,
    name: string,
    tier: number,
  ): Promise<void> {
    return resourceTracking.trackCreature(enemyId, name, tier);
  }

  function handleTogglePlayerVisibility(entityId: string): void {
    playerTracking.toggleVisibility(entityId);
  }

  function handleRemovePlayer(entityId: string): void {
    playerTracking.remove(entityId);
  }

  function handleToggleResourceLayer(id: number): void {
    resourceTracking.toggleLayer(id);
  }

  function handleRemoveResource(id: number): void {
    resourceTracking.remove(id);
  }

  function handleRegionsChange(): void {
    updateRegionIdParam(regionState.selected);
    resourceTracking.reloadRegions();
  }

  function handleToggleLayer(name: string): void {
    const layer = genericToggle[name];
    if (!layer || !map) return;
    if (map.hasLayer(layer)) {
      map.removeLayer(layer);
      activeLayers.delete(name);
    } else {
      map.addLayer(layer);
      activeLayers.add(name);
    }
    saveActiveLayerNames(activeLayers);
  }

  function isLayerActive(name: string): boolean {
    return activeLayers.has(name);
  }

  function handleBaseLayerChange(layer: BaseLayerName): void {
    if (!terrainTileLayer || !gameTileLayer) return;
    activeBaseLayer = layer;
    saveBaseLayerPreference(layer);

    if (layer === "terrain") {
      map.removeLayer(gameTileLayer);
      map.addLayer(terrainTileLayer);
    } else {
      map.removeLayer(terrainTileLayer);
      map.addLayer(gameTileLayer);
    }
  }

  function handleSearchSelect(entry: {
    latlng?: L.LatLng;
    layer: L.LayerGroup;
    selectionData?: import("$lib/types/map").MapSelection;
  }): void {
    if (!map.hasLayer(entry.layer)) {
      map.addLayer(entry.layer);
      // Sync activeLayers so the sidebar checkbox reflects the change
      for (const [name, layer] of Object.entries(genericToggle)) {
        if (layer === entry.layer) {
          activeLayers.add(name);
          break;
        }
      }
      saveActiveLayerNames(activeLayers);
    }
    if (entry.latlng) {
      // Zoom in to at least 1 so the selected marker is identifiable
      const targetZoom = Math.max(map.getZoom(), 1);
      map.flyTo(entry.latlng, targetZoom);
    }
    if (entry.selectionData) {
      setSelection(entry.selectionData);
    }
  }

  setContext("map", {
    getMap: () => map,
    toggleLayer: handleToggleLayer,
    isLayerActive,
    handleSearchSelect,
    handleToggleResourceLayer,
    genericToggle: () => genericToggle,
  });
</script>

<div class="relative h-viewport w-screen overflow-hidden bg-[#1E2742]">
  <div bind:this={mapElement} class="absolute inset-0 z-map"></div>

  {#if mapReady}
    <SearchBar
      onSelect={handleSearchSelect}
      onPlayerSelect={handlePlayerSelect}
      onResourceSelect={handleResourceSelect}
      onCreatureSelect={handleCreatureSelect}
    />
    <Sidebar
      {genericToggle}
      isActive={isLayerActive}
      onToggleLayer={handleToggleLayer}
      getBaseLayer={() => activeBaseLayer}
      onSetBaseLayer={handleBaseLayerChange}
      onToggleResource={handleToggleResourceLayer}
      onTogglePlayer={handleTogglePlayerVisibility}
      onRemoveResource={handleRemoveResource}
      onRemovePlayer={handleRemovePlayer}
      onRegionsChange={handleRegionsChange}
    />
    <DetailPanel
      onFollowPlayer={handlePlayerSelect}
    />
  {/if}

  <div
    class="absolute bottom-14 sm:bottom-3 left-3 z-ui flex flex-col items-start gap-2"
  >
    <GameTimers />
    <div class="flex items-center gap-2">
      <CoordinateDisplay {coords} />
      <ResetViewButton onReset={resetView} />
    </div>
  </div>
</div>

<style>
  :global(.leaflet-container) {
    background: #1e2742;
  }

  :global(.leaflet-image-layer),
  :global(.leaflet-tile-pane img) {
    image-rendering: pixelated;
    image-rendering: -moz-crisp-edges;
    image-rendering: crisp-edges;
    will-change: transform;
    backface-visibility: hidden;
  }
</style>
