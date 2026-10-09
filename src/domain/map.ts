import { constants as C, type WorldState } from '@openscreeps/engine';
import { GameError, type GameState } from '../contracts.ts';
import { isRoomName, roomNameToXY, type RoomInfo } from '../world/rooms.ts';
import {
  isRoomStatName,
  roomOverviewStats,
  roomStatTotals,
  statWindow,
  type RoomOverviewStats,
} from './room-stats.ts';
import { hasTerrain, ownValue, roomController } from './support.ts';

const DEFAULT_OVERVIEW_INTERVAL = 8;

export interface TerrainTile {
  room: string;
  x: number;
  y: number;
  type: 'wall' | 'swamp';
}

export interface MapStatsInput {
  rooms: readonly string[];
  /** Room stat name followed by its interval in minutes, e.g. `energyHarvested8`. */
  statName: string;
}

export interface MapStats {
  gameTime: number;
  stats: Record<string, Record<string, unknown>>;
  statsMax: Record<string, number>;
  /** Users referenced by the stats (owners, sign authors, ranked players). */
  userIds: Set<string>;
}

export interface RoomOverview extends RoomOverviewStats {
  ownerId: string | undefined;
}

function roomStatusOf(info: RoomInfo): Record<string, unknown> {
  const status: Record<string, unknown> = {};
  for (const key of ['status', 'novice', 'respawnArea', 'openTime'] as const) {
    if (info[key] !== undefined) {
      status[key] = info[key];
    }
  }
  return status;
}

/** Upstream `_.pick(room, ['status', 'novice', 'respawnArea', 'openTime'])`; `{}` for no room. */
export function roomStatus(world: WorldState, room?: string): Record<string, unknown> {
  const info = ownValue(world.rooms, room);
  return info ? roomStatusOf(info) : {};
}

/** Upstream `calcWorldSize` over the room documents (whose maxima start at 0). */
export function worldSize(world: WorldState): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const room of Object.keys(world.rooms)) {
    if (!isRoomName(room)) {
      continue;
    }
    const [x, y] = roomNameToXY(room);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return minX === Infinity ? 0 : Math.max(maxX - minX + 1, maxY - minY + 1);
}

/** Encoded terrain of a room (one digit per tile), or `invalid room`. */
export function roomTerrain(world: WorldState, room: string): string {
  const terrain = ownValue(world.terrain, room);
  if (terrain === undefined) {
    throw new GameError('invalid room');
  }
  return terrain;
}

/** Wall and swamp tiles of an encoded room terrain, row by row. */
export function terrainTiles(room: string, terrain: string): TerrainTile[] {
  const tiles: TerrainTile[] = [];
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_WALL)) {
        tiles.push({ room, x, y, type: 'wall' });
      }
      if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_SWAMP)) {
        tiles.push({ room, x, y, type: 'swamp' });
      }
    }
  }
  return tiles;
}

/**
 * Upstream `/map-stats`: per requested room its status, ownership, sign, safe mode, power and
 * mineral, plus the requested room stat ranked by player over its interval.
 */
export function mapStats(state: GameState, now: number, input: MapStatsInput): MapStats {
  const { world, statistics } = state;
  const { statName } = input;
  const match = /^(.*?)(\d+)$/.exec(statName);
  if (!match) {
    throw new GameError('invalid params');
  }
  const gameTime = world.gameTime;
  const stats: Record<string, Record<string, unknown>> = {};
  const requested = new Set<string>();
  for (const room of input.rooms) {
    const info = ownValue(world.rooms, room);
    if (info) {
      requested.add(room);
      stats[room] = roomStatusOf(info);
    }
  }
  const userIds = new Set<string>();
  for (const object of Object.values(world.roomObjects)) {
    const entry = requested.has(object.room) ? stats[object.room] : undefined;
    if (!entry) {
      continue;
    }
    if (object.type === 'controller') {
      if (object.user) {
        entry['own'] = { user: object.user, level: object.level };
        userIds.add(object.user);
      }
      if (object.reservation) {
        entry['own'] = { user: object.reservation.user, level: 0 };
        userIds.add(object.reservation.user);
      }
      if (object.sign) {
        entry['sign'] = object.sign;
        userIds.add(object.sign.user);
      }
      if (object.hardSign) {
        entry['hardSign'] = object.hardSign;
      }
      if ((object.safeMode ?? 0) > gameTime) {
        entry['safeMode'] = true;
      }
      if (object.isPowerEnabled) {
        entry['isPowerEnabled'] = true;
      }
    }
    if (object.type === 'invaderCore' && (object.level ?? 0) > 0 && object.user) {
      entry['own'] = { user: object.user, level: object.level };
      userIds.add(object.user);
    }
    if (object.type === 'mineral') {
      entry['minerals0'] = { type: object.mineralType, density: object.density };
    }
  }
  const statsMax: Record<string, number> = {};
  const [, name = '', interval = ''] = match;
  const window = statWindow(Number(interval), now);
  if (isRoomStatName(name) && window) {
    let max = 0;
    const totals = roomStatTotals(statistics, name, window, (id) => Object.hasOwn(world.users, id));
    for (const [room, byUser] of totals) {
      const list = [...byUser]
        .map(([user, value]) => ({ user, value }))
        .sort((a, b) => b.value - a.value);
      max = Math.max(max, list[0]?.value ?? 0);
      const entry = requested.has(room) ? stats[room] : undefined;
      if (entry) {
        entry[statName] = list;
        for (const item of list) {
          userIds.add(item.user);
        }
      }
    }
    statsMax[statName] = max;
  }
  return { gameTime, stats, statsMax, userIds };
}

/**
 * Upstream `/room-overview`: the room's controller owner and its stat graphs over an interval in
 * minutes (8, 180 or 1440; anything else falls back to 8).
 */
export function roomOverview(
  state: GameState,
  now: number,
  input: { room?: string | undefined; interval?: number | undefined },
): RoomOverview {
  const { world, statistics } = state;
  const { room } = input;
  if (room === undefined || !Object.hasOwn(world.rooms, room)) {
    throw new GameError('invalid room');
  }
  const window =
    statWindow(input.interval ?? DEFAULT_OVERVIEW_INTERVAL, now) ??
    statWindow(DEFAULT_OVERVIEW_INTERVAL, now);
  if (!window) {
    throw new GameError('invalid params');
  }
  return {
    ownerId: roomController(world, room)?.user ?? undefined,
    ...roomOverviewStats(statistics, room, window, (id) => Object.hasOwn(world.users, id)),
  };
}
