const LAYERS_STORAGE_KEY = "activeLayers";
const BASELAYER_STORAGE_KEY = "activeBaseLayer";

export const DEFAULT_LAYERS = ["Events", "Wonders", "Temples", "Ruined Cities"];

export type BaseLayerName = "terrain" | "game";

export function loadBaseLayerPreference(): BaseLayerName {
  try {
    const stored = localStorage.getItem(BASELAYER_STORAGE_KEY);
    return stored === "game" ? "game" : "terrain";
  } catch {
    return "terrain";
  }
}

export function saveBaseLayerPreference(layer: BaseLayerName): void {
  try {
    localStorage.setItem(BASELAYER_STORAGE_KEY, layer);
  } catch {
    /* ignore */
  }
}

export function loadActiveLayerNames(): string[] | null {
  try {
    const stored = localStorage.getItem(LAYERS_STORAGE_KEY);
    if (stored === null) return null;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

export function saveActiveLayerNames(names: Iterable<string>): void {
  try {
    localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify([...names]));
  } catch {
    /* ignore */
  }
}
