import L from "leaflet";
import { setSelection } from "$lib/stores/selection-store.svelte";
import { buildPopupHtml } from "./popup-builder";
import {
  connectWebSocket,
  type PlayerState,
} from "$lib/services/websocket-service";
import { lookupPlayer } from "$lib/services/player-service";
import {
  addTrackingItem,
  loadColorPreference,
} from "$lib/stores/tracking-store.svelte";
import { updatePlayerIdParam } from "$lib/utils/url-params";

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
  private playerWebSockets = new Map<string, WebSocket>();
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
      this.trackedPlayerIds.add(id);
    }

    // Fetch player info once for initial markers + tracking items
    const playerInfoPromise = Promise.all(
      playerIds.map((id) => lookupPlayer(id)),
    );

    playerInfoPromise.then((results) => {
      results.forEach((info, i) => {
        this.playerUsernames.set(playerIds[i], info.username);
        if (info.locationX !== null && info.locationZ !== null) {
          this.updateMarker(
            {
              entity_id: playerIds[i],
              location_x: info.locationX,
              location_z: info.locationZ,
              destination_x: info.locationX,
              destination_z: info.locationZ,
            },
            this.followingPlayerId === playerIds[i],
            loadColorPreference("player", playerIds[i]) || "#00ff00",
          );
        }
      });
    });

    const ws = connectWebSocket(
      playerIds,
      (state: PlayerState) => {
        this.updateMarker(
          state,
          this.followingPlayerId === state.entity_id,
          loadColorPreference("player", state.entity_id) || "#00ff00",
        );
      },
      () => {
        playerInfoPromise.then((results) => {
          playerIds.forEach((id, i) => {
            const savedColor = loadColorPreference("player", id);
            addTrackingItem({
              id: -1,
              entityId: id,
              type: "player",
              text: `Player: ${results[i].username}`,
              color: savedColor || "#00ff00",
              visible: true,
            });
          });
        });
      },
    );
    if (ws) {
      for (const id of playerIds) {
        this.playerWebSockets.set(id, ws);
      }
    }
  }

  async track(entityId: string, username: string): Promise<void> {
    if (this.trackedPlayerIds.has(entityId)) return;
    this.trackedPlayerIds.add(entityId);
    this.playerUsernames.set(entityId, username);
    updatePlayerIdParam(this.trackedPlayerIds);

    const paletteColor =
      PLAYER_COLOR_PALETTE[this.colorIndex % PLAYER_COLOR_PALETTE.length];
    this.colorIndex++;
    const color = loadColorPreference("player", entityId) || paletteColor;

    // Fetch initial location from API
    const playerInfo = await lookupPlayer(entityId);
    if (playerInfo.locationX !== null && playerInfo.locationZ !== null) {
      this.updateMarker(
        {
          entity_id: entityId,
          location_x: playerInfo.locationX,
          location_z: playerInfo.locationZ,
          destination_x: playerInfo.locationX,
          destination_z: playerInfo.locationZ,
        },
        this.followingPlayerId === entityId,
        color,
      );
    }

    const ws = connectWebSocket(
      [entityId],
      (state: PlayerState) => {
        this.updateMarker(
          state,
          this.followingPlayerId === state.entity_id,
          loadColorPreference("player", entityId) || color,
        );
      },
      () => {
        addTrackingItem({
          id: -1,
          entityId,
          type: "player",
          text: `Player: ${playerInfo.username}`,
          color,
          visible: true,
        });
      },
    );

    if (ws) {
      this.playerWebSockets.set(entityId, ws);
    }
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

    // Close WebSocket
    const ws = this.playerWebSockets.get(entityId);
    if (ws) {
      ws.close();
      this.playerWebSockets.delete(entityId);
    }
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
    state: PlayerState,
    followPlayer: boolean,
    color = "#00ff00",
  ): void {
    const playerId = state.entity_id;
    const playerLatLng = L.latLng(
      state.location_z / 1000,
      state.location_x / 1000,
    );
    const destLatLng = L.latLng(
      state.destination_z / 1000,
      state.destination_x / 1000,
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
      marker.bindPopup(buildPopupHtml(selectionData), {
        className: "bcm-leaflet-popup",
        pane: "popupOnTop",
      });
      marker.on("click", () => {
        selectionData.latlng = {
          lat: marker.getLatLng().lat,
          lng: marker.getLatLng().lng,
        };
        selectionData.isFollowing = this.followingPlayerId === playerId;
        setSelection(selectionData);
        marker.setPopupContent(buildPopupHtml(selectionData));
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
    for (const ws of this.playerWebSockets.values()) {
      ws.close();
    }
  }
}
