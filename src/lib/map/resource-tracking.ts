import type L from "leaflet";
import { ResourceCanvasLayer } from "./resource-canvas-layer";
import { fetchResource, fetchEnemy } from "$lib/services/api-service";
import {
  subscribeResource,
  unsubscribeResource,
} from "$lib/services/websocket-service";
import {
  cancelPendingRefetches,
  cancelAllPendingRefetches,
} from "$lib/services/resource-update-handler";
import {
  addTrackingItem,
  loadColorPreference,
} from "$lib/stores/tracking-store.svelte";
import {
  updateResourceIdParam,
  updateEnemyIdParam,
} from "$lib/utils/url-params";
import {
  resourceIndex,
  resourceIndexOverride,
  creatureIndex,
} from "$lib/data/resource-index";
import { tierColors } from "$lib/config/tiers";
import { getLodEnabled } from "$lib/stores/settings-store.svelte";
import { filterUnique } from "$lib/utils/dedupe";

/** Copy a fetched MultiPoint's coordinates into the canvas layer for one region. */
function applyRegionPoints(
  canvasLayer: ResourceCanvasLayer,
  regionId: number,
  geoJson: GeoJSON.FeatureCollection,
): void {
  const geometry = geoJson.features[0]?.geometry as
    | GeoJSON.MultiPoint
    | undefined;
  if (geometry && (geometry.coordinates?.length ?? 0) > 0) {
    canvasLayer.setRegionPoints(
      regionId,
      geometry.coordinates as [number, number][],
    );
  }
}

/**
 * Fetch one entity across regions, tolerating per-region failures —
 * the backend returns 403 for regions it doesn't serve yet.
 */
async function fetchRegionsSettled(
  regions: number[],
  fetcher: (regionId: number) => Promise<GeoJSON.FeatureCollection>,
  apply: (regionId: number, geoJson: GeoJSON.FeatureCollection) => void,
): Promise<void> {
  const results = await Promise.allSettled(regions.map(fetcher));
  regions.forEach((rId, idx) => {
    const result = results[idx];
    if (result.status === "fulfilled") {
      apply(rId, result.value);
    } else {
      console.warn(`Region ${rId} unavailable:`, result.reason);
    }
  });
}

function resolveResourceColor(id: number): string {
  return (
    loadColorPreference("resource", id) ||
    resourceIndexOverride[id]?.color ||
    tierColors[resourceIndexOverride[id]?.tier] ||
    resourceIndex[id]?.color ||
    tierColors[resourceIndex[id]?.tier] ||
    "#3388ff"
  );
}

function resolveCreatureColor(id: number): string {
  return (
    loadColorPreference("enemy", id) ||
    creatureIndex[id]?.color ||
    tierColors[creatureIndex[id]?.tier] ||
    "#3388ff"
  );
}

export interface TrackOptions {
  /** Skip writing the id back into the `?resourceId=`/`?enemyId=` params. */
  updateUrl?: boolean;
  /** Ignore tier/index colours and use the default blue. */
  noColors?: boolean;
}

export class ResourceTracking {
  /**
   * Resource and enemy ids come from separate id spaces that overlap heavily,
   * so their layers have to be kept in separate maps.
   */
  readonly resourceLayers: Record<number, ResourceCanvasLayer> = {};
  readonly enemyLayers: Record<number, ResourceCanvasLayer> = {};
  private trackedResourceIds = new Set<number>();
  private trackedEnemyIds = new Set<number>();

  constructor(
    private map: L.Map,
    private getRegions: () => number[],
  ) {}

  async trackResource(
    resourceId: number,
    name: string,
    tier: number,
    options: TrackOptions = {},
  ): Promise<void> {
    if (this.resourceLayers[resourceId]) return; // already loaded

    this.trackedResourceIds.add(resourceId);
    if (options.updateUrl !== false) {
      updateResourceIdParam(this.trackedResourceIds);
    }

    const color = options.noColors
      ? "#3388ff"
      : loadColorPreference("resource", resourceId) ||
        tierColors[tier] ||
        "#3388ff";
    const canvasLayer = this.addCanvasLayer(
      "resource",
      resourceId,
      name,
      tier,
      color,
    );

    addTrackingItem({
      id: resourceId,
      type: "resource",
      text: `Tracking: ${name}, Tier ${tier}`,
      color,
      visible: true,
    });

    try {
      await fetchRegionsSettled(
        this.getRegions(),
        (rId) => fetchResource(rId, resourceId),
        (rId, geoJson) => applyRegionPoints(canvasLayer, rId, geoJson),
      );

      subscribeResource(resourceId);
    } catch (err) {
      console.error(`Failed to load resource ${resourceId}:`, err);
    }
  }

  async trackCreature(
    enemyId: number,
    name: string,
    tier: number,
    options: TrackOptions = {},
  ): Promise<void> {
    if (this.enemyLayers[enemyId]) return; // already loaded

    this.trackedEnemyIds.add(enemyId);
    if (options.updateUrl !== false) {
      updateEnemyIdParam(this.trackedEnemyIds);
    }

    const color = options.noColors
      ? "#3388ff"
      : loadColorPreference("enemy", enemyId) ||
        creatureIndex[enemyId]?.color ||
        tierColors[tier] ||
        "#3388ff";
    const canvasLayer = this.addCanvasLayer(
      "enemy",
      enemyId,
      name,
      tier,
      color,
    );

    addTrackingItem({
      id: enemyId,
      type: "enemy",
      text: `Tracking: ${name}, Tier ${tier}`,
      color,
      visible: true,
    });

    try {
      await fetchRegionsSettled(
        this.getRegions(),
        (rId) => fetchEnemy(rId, enemyId),
        (rId, geoJson) => applyRegionPoints(canvasLayer, rId, geoJson),
      );
    } catch (err) {
      console.error(`Failed to load creature ${enemyId}:`, err);
    }
  }

  /** Load resources/enemies named in the `?resourceId=` / `?enemyId=` URL params. */
  async loadFromUrl(
    resourceParam: string,
    enemyParam: string,
    noColors: boolean,
  ): Promise<void> {
    if (!resourceParam && !enemyParam) return;

    const regionIds = this.getRegions();

    let resourceIds: number[] = [];
    if (resourceParam) {
      if (!/^([0-9]\d*)(,([0-9]\d*))*$/.test(resourceParam)) return;
      resourceIds = [...new Set(resourceParam.split(",").map(Number))];
      for (const id of resourceIds) {
        this.trackedResourceIds.add(id);
      }
    }

    let enemyIds: number[] = [];
    if (enemyParam) {
      if (!/^([0-9]\d*)(,([0-9]\d*))*$/.test(enemyParam)) return;
      enemyIds = [...new Set(enemyParam.split(",").map(Number))];
      for (const id of enemyIds) {
        this.trackedEnemyIds.add(id);
      }
    }

    const fetchPromises: Promise<GeoJSON.FeatureCollection>[] = [];
    const geoJsonMeta: {
      region: number;
      id: number;
      type: "resource" | "enemy";
    }[] = [];
    let trackingList: {
      text: string;
      color: string;
      id: number;
      type: "resource" | "enemy";
    }[] = [];

    for (const id of resourceIds) {
      const color = noColors ? "#3388ff" : resolveResourceColor(id);
      const tier =
        resourceIndexOverride[id]?.tier || resourceIndex[id]?.tier || 0;
      const name = resourceIndex[id]?.name || "ID " + id;
      this.addCanvasLayer("resource", id, name, tier, color);
    }
    for (const id of enemyIds) {
      const color = noColors ? "#3388ff" : resolveCreatureColor(id);
      const tier = creatureIndex[id]?.tier || 0;
      const name = creatureIndex[id]?.name || "ID " + id;
      this.addCanvasLayer("enemy", id, name, tier, color);
    }

    for (const rId of regionIds) {
      for (const resId of resourceIds) {
        const color = noColors ? "#3388ff" : resolveResourceColor(resId);
        const tier =
          resourceIndexOverride[resId]?.tier || resourceIndex[resId]?.tier || 0;
        const name = resourceIndex[resId]?.name || "ID " + resId;
        geoJsonMeta.push({ region: rId, id: resId, type: "resource" });
        fetchPromises.push(fetchResource(rId, resId));
        trackingList.push({
          text: "Tracking: " + name + ", Tier " + tier,
          color,
          id: resId,
          type: "resource",
        });
      }
      for (const eId of enemyIds) {
        const color = noColors ? "#3388ff" : resolveCreatureColor(eId);
        const tier = creatureIndex[eId]?.tier || 0;
        const name = creatureIndex[eId]?.name || "ID " + eId;
        geoJsonMeta.push({ region: rId, id: eId, type: "enemy" });
        fetchPromises.push(fetchEnemy(rId, eId));
        trackingList.push({
          text: "Tracking: " + name + ", Tier " + tier,
          color,
          id: eId,
          type: "enemy",
        });
      }
    }

    trackingList = filterUnique(trackingList);
    for (const item of trackingList) {
      addTrackingItem({
        id: item.id,
        type: item.type,
        text: item.text,
        color: noColors
          ? "#3388ff"
          : loadColorPreference(item.type, item.id) || item.color,
        visible: true,
      });
    }

    if (fetchPromises.length === 0) return;
    const geoJsonResults = await Promise.allSettled(fetchPromises);

    geoJsonResults.forEach((result, idx) => {
      const meta = geoJsonMeta[idx];
      if (result.status !== "fulfilled") {
        console.warn(
          `Region ${meta.region} unavailable for ${meta.type} ${meta.id}:`,
          result.reason,
        );
        return;
      }
      const canvasLayer = this.layersFor(meta.type)[meta.id];
      if (canvasLayer) {
        applyRegionPoints(canvasLayer, meta.region, result.value);
      }
    });

    // Subscribe to resource WebSocket channels
    for (const id of resourceIds) {
      subscribeResource(id);
    }
  }

  /** Refetch everything tracked after the active region set changes. */
  reloadRegions(): void {
    const resourceIds = [...this.trackedResourceIds];
    const enemyIds = [...this.trackedEnemyIds];
    if (resourceIds.length === 0 && enemyIds.length === 0) return;

    cancelAllPendingRefetches();

    const regions = this.getRegions();
    const reload = (
      type: "resource" | "enemy",
      ids: number[],
      fetcher: (regionId: number, id: number) => Promise<GeoJSON.FeatureCollection>,
    ): void => {
      const layers = this.layersFor(type);
      // Clear all region data from canvas layers before refetching
      for (const id of ids) {
        layers[id]?.clearAllRegions();
      }
      for (const id of ids) {
        fetchRegionsSettled(
          regions,
          (rId) => fetcher(rId, id),
          (rId, geoJson) => {
            const canvasLayer = layers[id];
            if (canvasLayer) applyRegionPoints(canvasLayer, rId, geoJson);
          },
        ).catch((err) =>
          console.error(`Failed to reload ${type} ${id}:`, err),
        );
      }
    };

    reload("resource", resourceIds, fetchResource);
    reload("enemy", enemyIds, fetchEnemy);
  }

  toggleLayer(id: number, type: "resource" | "enemy" = "resource"): void {
    const layer = this.layersFor(type)[id];
    if (!layer) return;
    if (this.map.hasLayer(layer)) {
      this.map.removeLayer(layer);
    } else {
      this.map.addLayer(layer);
    }
  }

  remove(id: number, type: "resource" | "enemy" = "resource"): void {
    const layers = this.layersFor(type);
    const layer = layers[id];
    if (layer) {
      layer.remove();
      delete layers[id];
    }
    if (type === "enemy") {
      this.trackedEnemyIds.delete(id);
      updateEnemyIdParam(this.trackedEnemyIds);
      return;
    }
    this.trackedResourceIds.delete(id);
    updateResourceIdParam(this.trackedResourceIds);
    cancelPendingRefetches(id);
    unsubscribeResource(id);
  }

  setLodEnabled(enabled: boolean): void {
    for (const layer of this.allLayers()) {
      layer.setLodEnabled(enabled);
    }
  }

  setColor(id: number, color: string, type: "resource" | "enemy"): void {
    this.layersFor(type)[id]?.setColor(color);
  }

  private layersFor(
    type: "resource" | "enemy",
  ): Record<number, ResourceCanvasLayer> {
    return type === "enemy" ? this.enemyLayers : this.resourceLayers;
  }

  private allLayers(): ResourceCanvasLayer[] {
    return [
      ...Object.values(this.resourceLayers),
      ...Object.values(this.enemyLayers),
    ];
  }

  private addCanvasLayer(
    type: "resource" | "enemy",
    id: number,
    name: string,
    tier: number,
    color: string,
  ): ResourceCanvasLayer {
    const canvasLayer = new ResourceCanvasLayer({ color, name, tier, id });
    this.layersFor(type)[id] = canvasLayer;
    canvasLayer.addTo(this.map);
    canvasLayer.setLodEnabled(getLodEnabled());
    return canvasLayer;
  }
}
