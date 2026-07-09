import L from "leaflet";
import "leaflet.markercluster";

export interface MapLayers {
  eventsLayer: L.LayerGroup;
  treesLayer: L.LayerGroup;
  ruinedLayer: L.LayerGroup;
  templesLayer: L.LayerGroup;
  banksLayer: L.LayerGroup;
  marketsLayer: L.LayerGroup;
  waystonesLayer: L.LayerGroup;
  gridsLayer: L.LayerGroup;
  dungeonsLayer: L.LayerGroup;
  towersLayer: L.LayerGroup;
  territoriesLayer: L.LayerGroup;
  hexiteLayer: L.LayerGroup;
  makersTreeLayer: L.LayerGroup;
  geysersLayer: L.LayerGroup;
  hermitCrabDensLayer: L.LayerGroup;
  shipwrecksLayer: L.LayerGroup;
  unchartedRuinsLayer: L.LayerGroup;
  silkmothLayer: L.LayerGroup;
  travelerCampLayer: L.LayerGroup;
  waypointsLayer: L.LayerGroup;
  roadsLayer: L.LayerGroup;
  claimLayers: L.LayerGroup[];
  caveLayers: L.LayerGroup[];
  allClaims: L.LayerGroup;
  allCaves: L.LayerGroup;
  /** Layer-panel display name -> toggleable layer */
  genericToggle: Record<string, L.LayerGroup>;
  /** Internal layer name -> layer, used by the GeoJSON painter */
  allLayers: Record<string, L.LayerGroup>;
}

export function createMapLayers(roadsTileLayer: L.TileLayer): MapLayers {
  // Only use MarkerClusterGroup for caves (1642 markers) — other layers are small enough (<100) for plain LayerGroups
  const eventsLayer = L.layerGroup();
  const treesLayer = L.layerGroup();
  const ruinedLayer = L.layerGroup();
  const templesLayer = L.layerGroup();
  const banksLayer = L.layerGroup();
  const marketsLayer = L.layerGroup();
  const waystonesLayer = L.layerGroup();
  const gridsLayer = L.layerGroup();
  const dungeonsLayer = L.layerGroup();
  const towersLayer = L.layerGroup();
  const territoriesLayer = L.layerGroup();
  const hexiteLayer = L.layerGroup();
  const makersTreeLayer = L.layerGroup();
  const geysersLayer = L.layerGroup();
  const hermitCrabDensLayer = L.layerGroup();
  const shipwrecksLayer = L.layerGroup();
  const unchartedRuinsLayer = L.layerGroup();
  const silkmothLayer = L.layerGroup();
  const travelerCampLayer = L.layerGroup();
  const waypointsLayer = L.layerGroup();

  const claimLayers = Array.from({ length: 11 }, () => L.layerGroup());
  const caveLayers: L.LayerGroup[] = Array.from({ length: 10 }, (_, i) => {
    const iconUrl = `/images/ore/t${i + 1}.webp`;
    return L.markerClusterGroup({
      maxClusterRadius: 50,
      disableClusteringAtZoom: 2,
      chunkedLoading: true,
      chunkInterval: 100,
      animate: false,
      iconCreateFunction(cluster) {
        const count = cluster.getChildCount();
        return L.divIcon({
          html: `<img src="${iconUrl}" /><span class="cluster-count">${count}</span>`,
          className: "cave-cluster-icon",
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
      },
    });
  });
  const allClaims = L.layerGroup(claimLayers);
  const allCaves = L.layerGroup(caveLayers);

  const roadsLayer = L.layerGroup([roadsTileLayer]);

  const genericToggle: Record<string, L.LayerGroup> = {
    Events: eventsLayer,
    Wonders: treesLayer,
    "Hexite Deposits": hexiteLayer,
    "Maker's Trees": makersTreeLayer,
    Temples: templesLayer,
    "Ruined Cities": ruinedLayer,
    "Traveler Camps": travelerCampLayer,
    "Volcanic Geysers": geysersLayer,
    "Hermit Crab Dens": hermitCrabDensLayer,
    Shipwrecks: shipwrecksLayer,
    "Uncharted Ruins": unchartedRuinsLayer,
    "Silkmoth Breeding Grounds": silkmothLayer,
    Banks: banksLayer,
    Markets: marketsLayer,
    Waystones: waystonesLayer,
    Grids: gridsLayer,
    Dungeons: dungeonsLayer,
    Territories: territoriesLayer,
    Watchtowers: towersLayer,
    "Custom Waypoints": waypointsLayer,
    Claims: allClaims,
    "Claims T1": claimLayers[1],
    "Claims T2": claimLayers[2],
    "Claims T3": claimLayers[3],
    "Claims T4": claimLayers[4],
    "Claims T5": claimLayers[5],
    "Claims T6": claimLayers[6],
    "Claims T7": claimLayers[7],
    "Claims T8": claimLayers[8],
    "Claims T9": claimLayers[9],
    "Claims T10": claimLayers[10],
    Caves: allCaves,
    "Caves T1": caveLayers[0],
    "Caves T2": caveLayers[1],
    "Caves T3": caveLayers[2],
    "Caves T4": caveLayers[3],
    "Caves T5": caveLayers[4],
    "Caves T6": caveLayers[5],
    "Caves T7": caveLayers[6],
    "Caves T8": caveLayers[7],
    "Caves T9": caveLayers[8],
    "Caves T10": caveLayers[9],
    Roads: roadsLayer,
  };

  const allLayers: Record<string, L.LayerGroup> = {
    eventsLayer,
    treesLayer,
    hexiteLayer,
    makersTreeLayer,
    geysersLayer,
    hermitCrabDensLayer,
    shipwrecksLayer,
    unchartedRuinsLayer,
    silkmothLayer,
    travelerCampLayer,
    templesLayer,
    ruinedLayer,
    banksLayer,
    marketsLayer,
    waystonesLayer,
    waypointsLayer,
    dungeonsLayer,
    territoriesLayer,
    towersLayer,
    roadsLayer,
    claimT0Layer: claimLayers[0],
    claimT1Layer: claimLayers[1],
    claimT2Layer: claimLayers[2],
    claimT3Layer: claimLayers[3],
    claimT4Layer: claimLayers[4],
    claimT5Layer: claimLayers[5],
    claimT6Layer: claimLayers[6],
    claimT7Layer: claimLayers[7],
    claimT8Layer: claimLayers[8],
    claimT9Layer: claimLayers[9],
    claimT10Layer: claimLayers[10],
    caveT1Layer: caveLayers[0],
    caveT2Layer: caveLayers[1],
    caveT3Layer: caveLayers[2],
    caveT4Layer: caveLayers[3],
    caveT5Layer: caveLayers[4],
    caveT6Layer: caveLayers[5],
    caveT7Layer: caveLayers[6],
    caveT8Layer: caveLayers[7],
    caveT9Layer: caveLayers[8],
    caveT10Layer: caveLayers[9],
  };

  return {
    eventsLayer,
    treesLayer,
    ruinedLayer,
    templesLayer,
    banksLayer,
    marketsLayer,
    waystonesLayer,
    gridsLayer,
    dungeonsLayer,
    towersLayer,
    territoriesLayer,
    hexiteLayer,
    makersTreeLayer,
    geysersLayer,
    hermitCrabDensLayer,
    shipwrecksLayer,
    unchartedRuinsLayer,
    silkmothLayer,
    travelerCampLayer,
    waypointsLayer,
    roadsLayer,
    claimLayers,
    caveLayers,
    allClaims,
    allCaves,
    genericToggle,
    allLayers,
  };
}
