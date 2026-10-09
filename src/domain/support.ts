import { constants as C, type WorldState } from '@openscreeps/engine';
import { GameError, type GameContext, type RoomObject, type User } from '../contracts.ts';

/** What a gameplay operation needs from a game: its state and the wall clock. */
export type GameOperationContext = Pick<GameContext, 'state' | 'now'>;

export const CONSTRUCTION_COST: Readonly<Record<string, number>> = C.CONSTRUCTION_COST;
export const CONTROLLER_STRUCTURES: Readonly<Record<string, Readonly<Record<number, number>>>> =
  C.CONTROLLER_STRUCTURES;
const COLORS: readonly number[] = C.COLORS_ALL;

/** Own-property lookup that never resolves inherited members such as `__proto__` or `constructor`. */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Integral room tile coordinate (0..49). */
export function isRoomCoordinate(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 49;
}

export function isFlagColor(value: unknown): value is number {
  return typeof value === 'number' && COLORS.includes(value);
}

/** The world user an operation acts for. */
export function gameUser(world: WorldState, userId: string): User {
  const user = ownValue(world.users, userId);
  if (!user) {
    throw new GameError('invalid user');
  }
  return user;
}

/**
 * Upstream `checkGame`: the room must exist on this shard, be a world room (`W..`/`E..`) and be
 * inside the borders and already open. Without a room name upstream's `findOne({_id: undefined})`
 * matches any room document, so the name then fails the world room test as `not supported`.
 */
export function checkGameRoom(world: WorldState, room: string | undefined, now: number): string {
  if (room === undefined) {
    throw new GameError(Object.keys(world.rooms).length ? 'not supported' : 'invalid room');
  }
  const info = ownValue(world.rooms, room);
  if (!info) {
    throw new GameError('invalid room');
  }
  if (!/^(W|E)/.test(room)) {
    throw new GameError('not supported');
  }
  if (info.status === 'out of borders' || (info.openTime && info.openTime > now)) {
    throw new GameError('out of borders');
  }
  return room;
}

export function roomController(world: WorldState, room: string): RoomObject | undefined {
  return Object.values(world.roomObjects).find(
    (object) => object.room === room && object.type === 'controller',
  );
}

/** Upstream `parseInt(terrain.charAt(y * 50 + x)) & mask` (tiles outside the room have no terrain). */
export function hasTerrain(terrain: string, x: number, y: number, mask: number): boolean {
  return (Number.parseInt(terrain.charAt(y * 50 + x), 10) & mask) !== 0;
}
