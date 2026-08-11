import L from "leaflet";
import { setSelection } from "$lib/stores/selection-store.svelte";
import { buildPopupHtml } from "./popup-builder";
import {
  relayTrackPlayer,
  relayUntrackPlayer,
  type PlayerUpdateEvent,
} from "$lib/services/relay-service";
import type { MobileEntityState } from "$lib/relay-bindings";
import {
  addTrackingItem,
  loadColorPreference,
  updateTrackingItemTextByEntityId,
} from "$lib/stores/tracking-store.svelte";
import { updatePlayerIdParam } from "$lib/utils/url-params";
import type { TrackOptions } from "./resource-tracking";

const PLAYER_COLOR_PALETTE = [
  "#00ff00",
  "#ff6b6b",
  "#4ecdc4",
  "#ffe66d",
  "#a78bfa",
  "#f97316",
  "#06b6d4",
  "#ec4899",
];

function createPlayerIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: "player-marker-icon",
    html: `<div class="player-pulse" style="border-color: ${color};"></div><div class="player-dot" style="background-color: ${color};"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

export class PlayerTracking {
  private playerStore = new Map<string, L.Marker>();
  private destinationStore = new Map<string, L.Polyline>();
  private trackedPlayerIds = new Set<string>();
  private playerUsernames = new Map<string, string>();
  private colorIndex = 0;
  followingPlayerId: string | null = null;

  constructor(
    private map: L.Map,
    private liveLayer: L.FeatureGroup,
  ) {}

  /** Start tracking the players named in the `?playerId=` URL param. */
  trackFromUrl(playerIdParam: string, followFirst: boolean): void {
    const playerIds = playerIdParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (followFirst && playerIds.length > 0) {
      this.followingPlayerId = playerIds[0];
    }
    for (const id of playerIds) {
      if (this.trackedPlayerIds.has(id)) continue;
      this.trackedPlayerIds.add(id);
      this.startTracking(id, loadColorPreference("player", id) || "#00ff00");
    }
  }

  /**
   * @param username Display name if already known; otherwise it arrives with
   *   the relay's player_username_state row.
   */
  async track(
    entityId: string,
    username?: string,
    options: TrackOptions = {},
  ): Promise<void> {
    if (this.trackedPlayerIds.has(entityId)) return;
    this.trackedPlayerIds.add(entityId);
    if (username) this.playerUsernames.set(entityId, username);
    if (options.updateUrl !== false) {
      updatePlayerIdParam(this.trackedPlayerIds);
    }

    const paletteColor =
      PLAYER_COLOR_PALETTE[this.colorIndex % PLAYER_COLOR_PALETTE.length];
    this.colorIndex++;
    const color = options.noColors
      ? "#3388ff"
      : loadColorPreference("player", entityId) || paletteColor;

    this.startTracking(entityId, color);
  }

  /**
   * Subscribe to the player's relay rows. The initial position, username and
   * online flag arrive through the same callback as later movement, so the
   * marker and the tracking-item label fill in as rows land.
   */
  private startTracking(entityId: string, color: string): void {
    addTrackingItem({
      id: -1,
      entityId,
      type: "player",
      text: `Player: ${this.playerUsernames.get(entityId) ?? entityId}`,
      color,
      visible: true,
    });

    relayTrackPlayer(entityId, (event: PlayerUpdateEvent) => {
      if (
        event.username &&
        event.username !== this.playerUsernames.get(entityId)
      ) {
        this.playerUsernames.set(entityId, event.username);
        updateTrackingItemTextByEntityId(entityId, `Player: ${event.username}`);
      }
      if (event.state) {
        this.updateMarker(
          event.state,
          this.followingPlayerId === entityId,
          loadColorPreference("player", entityId) || color,
        );
      }
    });
  }

  /** Follow this player, or stop following if they are already followed. */
  toggleFollow(entityId: string): void {
    if (this.followingPlayerId === entityId) {
      this.followingPlayerId = null;
    } else {
      this.followingPlayerId = entityId;
      const existing = this.playerStore.get(entityId);
      if (existing) {
        // should always be present if we just clicked follow on their marker
        this.map.flyTo(existing.getLatLng(), this.map.getZoom());
      }
    }
  }

  toggleVisibility(entityId: string): void {
    const marker = this.playerStore.get(entityId);
    const dest = this.destinationStore.get(entityId);
    if (marker) {
      if (this.liveLayer.hasLayer(marker)) {
        this.liveLayer.removeLayer(marker);
        if (dest) this.liveLayer.removeLayer(dest);
      } else {
        this.liveLayer.addLayer(marker);
        if (dest) this.liveLayer.addLayer(dest);
      }
    }
  }

  remove(entityId: string): void {
    // Remove markers
    const marker = this.playerStore.get(entityId);
    const dest = this.destinationStore.get(entityId);
    if (marker) this.liveLayer.removeLayer(marker);
    if (dest) this.liveLayer.removeLayer(dest);
    this.playerStore.delete(entityId);
    this.destinationStore.delete(entityId);
    this.playerUsernames.delete(entityId);

    relayUntrackPlayer(entityId);
    this.trackedPlayerIds.delete(entityId);
    updatePlayerIdParam(this.trackedPlayerIds);
  }

  setMarkerColor(entityId: string, color: string): void {
    const marker = this.playerStore.get(entityId);
    if (!marker) return;
    const el = marker.getElement();
    if (!el) return;
    const dot = el.querySelector(".player-dot") as HTMLElement;
    const pulse = el.querySelector(".player-pulse") as HTMLElement;
    if (dot) dot.style.backgroundColor = color;
    if (pulse) pulse.style.borderColor = color;
  }

  private updateMarker(
    state: MobileEntityState,
    followPlayer: boolean,
    color = "#00ff00",
  ): void {
    const playerId = String(state.entityId);
    // mobile_entity_state coords are small hex tile * 1000 — the map's grid scaled.
    const playerLatLng = L.latLng(
      state.locationZ / 1000,
      state.locationX / 1000,
    );
    const destLatLng = L.latLng(
      state.destinationZ / 1000,
      state.destinationX / 1000,
    );
    const directionLine: L.LatLngExpression[] = [playerLatLng, destLatLng];

    const existingMarker = this.playerStore.get(playerId);
    const existingDest = this.destinationStore.get(playerId);

    if (!existingMarker || !existingDest) {
      const icon = createPlayerIcon(color);
      const marker = L.marker(playerLatLng, {
        icon,
        pane: "markerOnTop",
      }).addTo(this.liveLayer);
      const username = this.playerUsernames.get(playerId) ?? playerId;
      const selectionData = {
        type: "player" as const,
        name: username,
        entityId: playerId,
        username,
        signedIn: true,
        latlng: { lat: playerLatLng.lat, lng: playerLatLng.lng },
        color,
        isFollowing: this.followingPlayerId === playerId,
      };
      marker.bindPopup(buildPopupHtml(selectionData, this.map.getZoom()), {
        className: "bcm-leaflet-popup",
        pane: "popupOnTop",
      });
      marker.on("click", () => {
        selectionData.latlng = {
          lat: marker.getLatLng().lat,
          lng: marker.getLatLng().lng,
        };
        selectionData.isFollowing = this.followingPlayerId === playerId;
        // The username may have arrived after the marker was created.
        const name = this.playerUsernames.get(playerId) ?? playerId;
        selectionData.name = name;
        selectionData.username = name;
        setSelection(selectionData);
        marker.setPopupContent(
          buildPopupHtml(selectionData, this.map.getZoom()),
        );
      });

      const trail = new L.Polyline(directionLine, {
        color: "#ff0000ff",
        weight: 1,
        opacity: 1,
        smoothFactor: 1,
      }).addTo(this.liveLayer);

      this.playerStore.set(playerId, marker);
      this.destinationStore.set(playerId, trail);
    } else {
      existingMarker.setLatLng(playerLatLng);
      existingDest.setLatLngs(directionLine);
    }

    if (followPlayer) {
      // use setView here instead of flyTo to workaround https://github.com/Leaflet/Leaflet/issues/9438
      this.map.setView(playerLatLng, this.map.getZoom());
    }
  }

  dispose(): void {
    for (const id of this.trackedPlayerIds) {
      relayUntrackPlayer(id);
    }
  }
}
