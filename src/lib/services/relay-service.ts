/**
 * relay-service.ts
 *
 * Live entity tracking over the relay.bitjita.com SpacetimeDB mirror.
 *
 * The relay carries every live game region verbatim as its own module
 * (`bitcraft-live-{N}`), so there is one DbConnection per region with tracked
 * data, created lazily when the first subscription for that region is wanted
 * and torn down when the last one goes. An unexpected drop while subscriptions
 * are still wanted schedules a reconnect that re-registers everything.
 *
 * The relay is read-only: everything here is subscriptions. Queries are always
 * filtered — a bare `SELECT * FROM location_state` is hundreds of megabytes.
 * The two-sided resource join (positions via semijoin, states for attribution)
 * and the client-side enemy filtering (`enemy_type` is a sum-type column,
 * which subscription SQL cannot compare to a number) follow the patterns
 * proven on bitjita.com's map.
 *
 * Rendering: rows land in the SDK client cache; on the initial
 * SubscriptionApplied and after each row callback the affected
 * (layer, region) pair is rebuilt in one pass from the cache into
 * ResourceCanvasLayer.setRegionPoints. Rebuilds are debounced so the initial
 * insert burst and busy regions collapse into one redraw.
 *
 * Coordinates: `location_state`/`herd_location` x/z are small hex tile units —
 * the map's native lat/lng. `mobile_entity_state` is the same grid * 1000;
 * player callbacks emit the raw values and the marker layer scales them.
 */

import type { ResourceCanvasLayer } from "$lib/map/resource-canvas-layer";
import { createAppConfig } from "$lib/config/api";
import {
  DbConnection,
  EnemyType,
  type EventContext,
  type LocationState,
  type MobileEntityState,
} from "$lib/relay-bindings";

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/** Live region set as of July 2026; replaced by /health discovery at runtime. */
const LIVE_REGIONS_FALLBACK = [3, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 23];

let liveRegions: number[] = [...LIVE_REGIONS_FALLBACK];
let discoveryStarted = false;

/** All regions the relay carries — used for player tracking, where the
 * player's region is unknown. Resource/enemy tracking uses the caller's
 * active region selection instead. */
function getLiveRegions(): number[] {
  discoverRegions();
  return liveRegions;
}

/** One-shot region discovery from the relay's /health module listing. */
function discoverRegions(): void {
  if (discoveryStarted) return;
  discoveryStarted = true;
  const config = createAppConfig();
  fetch(`${config.relayHost}/health`)
    .then((r) => (r.ok ? r.json() : null))
    .then((health: { modules?: Record<string, unknown> } | null) => {
      if (!health?.modules) return;
      const regions = Object.keys(health.modules)
        .map((name) => /^bitcraft-live-(\d+)$/.exec(name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
      if (regions.length > 0) {
        liveRegions = regions;
        // Players are subscribed on every live region; catch up any regions
        // the fallback list didn't know about.
        if (trackedPlayers.size > 0) reconcileAllRegions();
      }
    })
    .catch(() => {
      /* fallback list stays */
    });
}

// ---------------------------------------------------------------------------
// Subscription SQL
// ---------------------------------------------------------------------------

const SQL = {
  /** Positions of one resource type: location rows semijoined so only this
   * type's entities reach the wire. */
  resourcePositions: (resourceId: number) =>
    "SELECT location_state.* FROM location_state " +
    "JOIN resource_state ON location_state.entity_id = resource_state.entity_id " +
    `WHERE resource_state.resource_id = ${resourceId}`,
  /** The other side of the same join — which entity ids ARE this type. An
   * insert here is a node appearing, a delete is it going. */
  resourceStates: (resourceId: number) =>
    "SELECT resource_state.* FROM resource_state " +
    "JOIN location_state ON resource_state.entity_id = location_state.entity_id " +
    `WHERE resource_state.resource_id = ${resourceId}`,
  /** Herd positions come denormalised on this table — no join needed. The
   * enemy_type column is a sum type, which subscription SQL cannot filter,
   * so the table is subscribed whole (a few thousand rows per region) and
   * filtered client-side by variant index. */
  enemies: "SELECT * FROM enemy_mob_monitor_state",
  playerPosition: (entityId: string) =>
    `SELECT * FROM mobile_entity_state WHERE entity_id = ${entityId}`,
  playerName: (entityId: string) =>
    `SELECT * FROM player_username_state WHERE entity_id = ${entityId}`,
  playerSignedIn: (entityId: string) =>
    `SELECT * FROM signed_in_player_state WHERE entity_id = ${entityId}`,
};

// ---------------------------------------------------------------------------
// Tracked state
// ---------------------------------------------------------------------------

export interface PlayerUpdateEvent {
  entityId: string;
  /** Position row straight from the bindings; coords are small hex tile * 1000. */
  state?: MobileEntityState;
  username?: string;
  online?: boolean;
}

export type PlayerUpdateCallback = (event: PlayerUpdateEvent) => void;

interface TrackedLayer {
  layer: ResourceCanvasLayer;
  regions: Set<number>;
}

const trackedResources = new Map<number, TrackedLayer>();
const trackedEnemies = new Map<number, TrackedLayer>();
const trackedPlayers = new Map<string, PlayerUpdateCallback>();

// ---------------------------------------------------------------------------
// Enemy variant index
// ---------------------------------------------------------------------------

/** enemy_type decodes to a tagged union; the variant index is the numeric id
 * shared by enemy_desc and the creature index. */
let enemyTagToIndex: Map<string, number> | null = null;

function enemyVariantIndex(value: { tag: string }): number {
  if (!enemyTagToIndex) {
    const variants = EnemyType.getTypeScriptAlgebraicType().sum.variants as {
      name: string;
    }[];
    enemyTagToIndex = new Map(variants.map((v, i) => [v.name, i]));
  }
  return enemyTagToIndex.get(value.tag) ?? -1;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const RECONNECT_DELAY_MS = 5_000;
const REBUILD_DEBOUNCE_MS = 300;

interface Sub {
  unsubscribe(): void;
  isActive(): boolean;
}

interface RegionConn {
  region: number;
  conn: DbConnection | null;
  connected: boolean;
  closing: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Active subscription handles keyed by want-key (`res:{id}`, `enemies`,
   * `player:{id}`). Recreated from scratch on every (re)connect. */
  handles: Map<string, Sub>;
}

const regionConns = new Map<number, RegionConn>();

/** The want-keys and their queries for one region, derived from tracked state. */
function wantedSubs(region: number): Map<string, string[]> {
  const wants = new Map<string, string[]>();
  for (const [id, tracked] of trackedResources) {
    if (tracked.regions.has(region)) {
      wants.set(`res:${id}`, [SQL.resourceStates(id), SQL.resourcePositions(id)]);
    }
  }
  for (const tracked of trackedEnemies.values()) {
    if (tracked.regions.has(region)) {
      wants.set("enemies", [SQL.enemies]);
      break; // one whole-table subscription serves every tracked enemy type
    }
  }
  for (const entityId of trackedPlayers.keys()) {
    wants.set(`player:${entityId}`, [
      SQL.playerPosition(entityId),
      SQL.playerName(entityId),
      SQL.playerSignedIn(entityId),
    ]);
  }
  return wants;
}

function getOrCreateConn(region: number): RegionConn {
  let rc = regionConns.get(region);
  if (!rc) {
    rc = {
      region,
      conn: null,
      connected: false,
      closing: false,
      reconnectTimer: null,
      handles: new Map(),
    };
    regionConns.set(region, rc);
  }
  return rc;
}

function connect(rc: RegionConn): void {
  if (rc.conn) return;
  const config = createAppConfig();
  rc.closing = false;
  rc.conn = DbConnection.builder()
    .withUri(config.relayHost)
    .withModuleName(`bitcraft-live-${rc.region}`)
    .withLightMode(true)
    .onConnect(() => {
      console.log(`Relay region ${rc.region} connected`);
      rc.connected = true;
      reconcileRegion(rc.region);
    })
    .onConnectError((_ctx, err) => {
      console.error(`Relay region ${rc.region} connect error:`, err.message);
      dropConnection(rc, /* retry */ true);
    })
    .onDisconnect(() => {
      const planned = rc.closing;
      dropConnection(rc, /* retry */ !planned);
    })
    .build();
  registerRowCallbacks(rc);
}

/** Discard the connection object; optionally retry while still wanted. */
function dropConnection(rc: RegionConn, retry: boolean): void {
  rc.conn = null;
  rc.connected = false;
  rc.handles.clear();
  if (retry && wantedSubs(rc.region).size > 0 && !rc.reconnectTimer) {
    console.warn(`Relay region ${rc.region} dropped; reconnecting in ${RECONNECT_DELAY_MS}ms`);
    rc.reconnectTimer = setTimeout(() => {
      rc.reconnectTimer = null;
      if (wantedSubs(rc.region).size > 0) connect(rc);
    }, RECONNECT_DELAY_MS);
  }
}

/** Bring one region's connection and subscriptions in line with tracked state. */
function reconcileRegion(region: number): void {
  const wants = wantedSubs(region);
  const rc = regionConns.get(region);

  if (wants.size === 0) {
    if (rc) {
      rc.closing = true;
      if (rc.reconnectTimer) clearTimeout(rc.reconnectTimer);
      try {
        rc.conn?.disconnect();
      } catch {
        /* already closed */
      }
      regionConns.delete(region);
    }
    return;
  }

  const conn = getOrCreateConn(region);
  if (!conn.conn) {
    connect(conn);
    return; // onConnect reconciles
  }
  if (!conn.connected) return; // still handshaking; onConnect reconciles

  for (const [key, handle] of conn.handles) {
    if (!wants.has(key)) {
      try {
        if (handle.isActive()) handle.unsubscribe();
      } catch {
        /* socket already gone */
      }
      conn.handles.delete(key);
    }
  }

  for (const [key, queries] of wants) {
    if (conn.handles.has(key)) continue;
    const handle = conn.conn
      .subscriptionBuilder()
      .onApplied(() => onSubscriptionApplied(region, key))
      .onError(() =>
        console.error(`Relay region ${region} subscription ${key} failed`),
      )
      .subscribe(queries) as unknown as Sub;
    conn.handles.set(key, handle);
  }
}

function reconcileAllRegions(): void {
  const regions = new Set<number>([
    ...regionConns.keys(),
    ...[...trackedResources.values(), ...trackedEnemies.values()].flatMap((t) => [...t.regions]),
    ...(trackedPlayers.size > 0 ? getLiveRegions() : []),
  ]);
  for (const region of regions) reconcileRegion(region);
}

// ---------------------------------------------------------------------------
// Row callbacks -> debounced rebuilds
// ---------------------------------------------------------------------------

/** Dirty (kind, id, region) triples awaiting a rebuild. */
const dirty = new Set<string>();
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function markDirty(kind: "res" | "enemy", id: number, region: number): void {
  dirty.add(`${kind}:${id}:${region}`);
  if (!rebuildTimer) {
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      const batch = [...dirty];
      dirty.clear();
      for (const key of batch) {
        const [kind, id, region] = key.split(":");
        if (kind === "res") rebuildResourceRegion(Number(id), Number(region));
        else rebuildEnemyRegion(Number(id), Number(region));
      }
    }, REBUILD_DEBOUNCE_MS);
  }
}

function registerRowCallbacks(rc: RegionConn): void {
  const db = rc.conn!.db;
  const region = rc.region;

  // A resource_state row appearing/going is a node of some tracked type
  // spawning or depleting; the row carries its own attribution.
  const onResourceRow = (_ctx: EventContext, row: { resourceId: number }) => {
    if (trackedResources.has(row.resourceId)) markDirty("res", row.resourceId, region);
  };
  db.resourceState.onInsert(onResourceRow);
  db.resourceState.onDelete(onResourceRow);

  // location_state deltas carry no attribution, and looking the entity up in
  // the resource_state cache is O(n) per row — quadratic across the ~100k-row
  // initial burst. Just mark every tracked type on this region dirty; the
  // debounced rebuild re-derives attribution in one pass.
  const onLocationRow = (_ctx: EventContext, _row: LocationState) => {
    for (const id of trackedResources.keys()) markDirty("res", id, region);
  };
  db.locationState.onInsert(onLocationRow);
  db.locationState.onDelete(onLocationRow);

  const onEnemyRow = (_ctx: EventContext, row: { enemyType: { tag: string } }) => {
    const id = enemyVariantIndex(row.enemyType);
    if (trackedEnemies.has(id)) markDirty("enemy", id, region);
  };
  db.enemyMobMonitorState.onInsert(onEnemyRow);
  db.enemyMobMonitorState.onDelete(onEnemyRow);

  // Player rows: forward to the tracked player's callback.
  const emitState = (_ctx: EventContext, row: MobileEntityState) => {
    const id = String(row.entityId);
    trackedPlayers.get(id)?.({ entityId: id, state: row });
  };
  db.mobileEntityState.onInsert(emitState);
  db.mobileEntityState.onUpdate((ctx, _old, row) => emitState(ctx, row));

  db.playerUsernameState.onInsert((_ctx, row) => {
    const id = String(row.entityId);
    trackedPlayers.get(id)?.({ entityId: id, username: row.username });
  });
  db.playerUsernameState.onUpdate((_ctx, _old, row) => {
    const id = String(row.entityId);
    trackedPlayers.get(id)?.({ entityId: id, username: row.username });
  });

  db.signedInPlayerState.onInsert((_ctx, row) => {
    const id = String(row.entityId);
    trackedPlayers.get(id)?.({ entityId: id, online: true });
  });
  db.signedInPlayerState.onDelete((_ctx, row) => {
    const id = String(row.entityId);
    trackedPlayers.get(id)?.({ entityId: id, online: false });
  });
}

function onSubscriptionApplied(region: number, key: string): void {
  if (key.startsWith("res:")) {
    markDirty("res", Number(key.slice(4)), region);
  } else if (key === "enemies") {
    for (const id of trackedEnemies.keys()) markDirty("enemy", id, region);
  }
  // player:* — the row callbacks fired during the applied batch already
  // delivered the initial state.
}

// ---------------------------------------------------------------------------
// Cache -> canvas rebuilds
// ---------------------------------------------------------------------------

function rebuildResourceRegion(resourceId: number, region: number): void {
  const tracked = trackedResources.get(resourceId);
  const rc = regionConns.get(region);
  if (!tracked || !tracked.regions.has(region) || !rc?.connected || !rc.conn) return;

  const db = rc.conn.db;
  // One O(n) pass over each cache; the generated per-row find() is O(n) too,
  // which would make the join quadratic on 100k+ row regions.
  const locations = new Map<string, LocationState>();
  for (const row of db.locationState.iter()) {
    locations.set(String(row.entityId), row);
  }
  const points: [number, number][] = [];
  for (const row of db.resourceState.iter()) {
    if (row.resourceId !== resourceId) continue;
    const loc = locations.get(String(row.entityId));
    if (loc && loc.dimension === 1) points.push([loc.x, loc.z]);
  }

  if (points.length > 0) tracked.layer.setRegionPoints(region, points);
  else tracked.layer.clearRegion(region);
}

function rebuildEnemyRegion(enemyId: number, region: number): void {
  const tracked = trackedEnemies.get(enemyId);
  const rc = regionConns.get(region);
  if (!tracked || !tracked.regions.has(region) || !rc?.connected || !rc.conn) return;

  const points: [number, number][] = [];
  for (const row of rc.conn.db.enemyMobMonitorState.iter()) {
    if (enemyVariantIndex(row.enemyType) !== enemyId) continue;
    const loc = row.herdLocation;
    if (loc.dimension === 1) points.push([loc.x, loc.z]);
  }

  if (points.length > 0) tracked.layer.setRegionPoints(region, points);
  else tracked.layer.clearRegion(region);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function relayTrackResource(
  resourceId: number,
  layer: ResourceCanvasLayer,
  regions: number[],
): void {
  trackedResources.set(resourceId, { layer, regions: new Set(regions) });
  for (const region of regions) reconcileRegion(region);
}

export function relayUntrackResource(resourceId: number): void {
  const tracked = trackedResources.get(resourceId);
  if (!tracked) return;
  trackedResources.delete(resourceId);
  for (const region of tracked.regions) reconcileRegion(region);
}

export function relayTrackEnemy(
  enemyId: number,
  layer: ResourceCanvasLayer,
  regions: number[],
): void {
  trackedEnemies.set(enemyId, { layer, regions: new Set(regions) });
  for (const region of regions) reconcileRegion(region);
}

export function relayUntrackEnemy(enemyId: number): void {
  const tracked = trackedEnemies.get(enemyId);
  if (!tracked) return;
  trackedEnemies.delete(enemyId);
  for (const region of tracked.regions) reconcileRegion(region);
}

/** Re-scope every tracked resource/enemy to a new active region set. Layers
 * are cleared so stale regions disappear; kept regions repopulate from the
 * client cache or the fresh subscription. */
export function relaySetRegions(regions: number[]): void {
  const regionSet = new Set(regions);
  for (const tracked of trackedResources.values()) {
    tracked.regions = new Set(regionSet);
    tracked.layer.clearAllRegions();
  }
  for (const tracked of trackedEnemies.values()) {
    tracked.regions = new Set(regionSet);
    tracked.layer.clearAllRegions();
  }
  reconcileAllRegions();
  for (const id of trackedResources.keys()) {
    for (const region of regions) markDirty("res", id, region);
  }
  for (const id of trackedEnemies.keys()) {
    for (const region of regions) markDirty("enemy", id, region);
  }
}

/** Track one player across every live region — their region is unknown, and
 * each filtered query is at most one row. The callback receives partial
 * updates (position, name, online) as rows arrive. */
export function relayTrackPlayer(entityId: string, callback: PlayerUpdateCallback): void {
  if (!/^[0-9]{1,32}$/.test(entityId)) return;
  trackedPlayers.set(entityId, callback);
  for (const region of getLiveRegions()) reconcileRegion(region);
}

export function relayUntrackPlayer(entityId: string): void {
  if (!trackedPlayers.delete(entityId)) return;
  reconcileAllRegions();
}

/** Tear everything down (map teardown / HMR). */
export function relayDispose(): void {
  trackedResources.clear();
  trackedEnemies.clear();
  trackedPlayers.clear();
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  dirty.clear();
  reconcileAllRegions();
}
