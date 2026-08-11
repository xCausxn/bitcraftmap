import type L from "leaflet";
import { ResourceCanvasLayer } from "./resource-canvas-layer";
import {
  relayTrackResource,
  relayUntrackResource,
  relayTrackEnemy,
  relayUntrackEnemy,
  relaySetRegions,
} from "$lib/services/relay-service";
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

    relayTrackResource(resourceId, canvasLayer, this.getRegions());
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

    relayTrackEnemy(enemyId, canvasLayer, this.getRegions());
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
      const canvasLayer = this.addCanvasLayer("resource", id, name, tier, color);
      relayTrackResource(id, canvasLayer, regionIds);
      trackingList.push({
        text: "Tracking: " + name + ", Tier " + tier,
        color,
        id,
        type: "resource",
      });
    }
    for (const id of enemyIds) {
      const color = noColors ? "#3388ff" : resolveCreatureColor(id);
      const tier = creatureIndex[id]?.tier || 0;
      const name = creatureIndex[id]?.name || "ID " + id;
      const canvasLayer = this.addCanvasLayer("enemy", id, name, tier, color);
      relayTrackEnemy(id, canvasLayer, regionIds);
      trackingList.push({
        text: "Tracking: " + name + ", Tier " + tier,
        color,
        id,
        type: "enemy",
      });
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
  }

  /** Re-scope everything tracked after the active region set changes. */
  reloadRegions(): void {
    if (this.trackedResourceIds.size === 0 && this.trackedEnemyIds.size === 0)
      return;
    relaySetRegions(this.getRegions());
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
      relayUntrackEnemy(id);
      return;
    }
    this.trackedResourceIds.delete(id);
    updateResourceIdParam(this.trackedResourceIds);
    relayUntrackResource(id);
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
