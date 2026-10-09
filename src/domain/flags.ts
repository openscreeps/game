import { constants as C, type WorldState } from '@openscreeps/engine';
import { GameError, newId, type GameState } from '../contracts.ts';
import {
  checkGameRoom,
  isFlagColor,
  isRoomCoordinate,
  type GameOperationContext,
} from './support.ts';

type FlagDoc = WorldState['flags'][string];

/** One flag as stored upstream: `[name, color, secondaryColor, x, y]`. */
export type FlagEntry = string[];

export interface CreateFlagInput {
  room?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  name?: string | undefined;
  color?: number | undefined;
  secondaryColor?: number | undefined;
}

export interface ChangeFlagColorInput {
  room?: string | undefined;
  name?: string | undefined;
  color?: number | undefined;
  secondaryColor?: number | undefined;
}

export interface RemoveFlagInput {
  room?: string | undefined;
  name?: string | undefined;
}

/** Upstream `getFlags` parser for a `rooms.flags` document's `data` string. */
function parseFlags(data: string): FlagEntry[] {
  if (!data.length) {
    return [];
  }
  return data.split('|').map((entry) => {
    const item = entry.split('~');
    item[0] = (item[0] ?? '').replace(/\$VLINE\$/g, '|').replace(/\$TILDE\$/g, '~');
    return item;
  });
}

/** All flags of a user grouped by room (upstream `getFlags(user)`). */
export function userFlags(world: WorldState, userId: string): Map<string, FlagEntry[]> {
  const rooms = new Map<string, FlagEntry[]>();
  for (const doc of Object.values(world.flags)) {
    if (doc.user === userId) {
      rooms.set(doc.room, [...(rooms.get(doc.room) ?? []), ...parseFlags(doc.data)]);
    }
  }
  return rooms;
}

/**
 * Upstream `setFlags`: one document per user and room, serialized with the separator escapes the
 * engine and runtime parse. A room without flags drops its document, because the processor parses
 * an empty `data` string as one nameless flag.
 */
function saveRoomFlags(
  state: GameState,
  userId: string,
  room: string,
  flags: readonly FlagEntry[],
): void {
  const docs: FlagDoc[] = Object.values(state.world.flags).filter(
    (doc) => doc.user === userId && doc.room === room,
  );
  for (const duplicate of docs.slice(1)) {
    Reflect.deleteProperty(state.world.flags, duplicate._id);
  }
  const doc = docs[0];
  if (!flags.length) {
    if (doc) {
      Reflect.deleteProperty(state.world.flags, doc._id);
    }
    return;
  }
  const data = flags
    .map(([name = '', ...rest]) =>
      [name.replace(/\|/g, '$VLINE$').replace(/~/g, '$TILDE$'), ...rest].join('~'),
    )
    .join('|');
  if (doc) {
    doc.data = data;
    return;
  }
  const _id = newId(state);
  state.world.flags[_id] = { _id, user: userId, room, data };
}

/** Upstream `/create-flag`: creates a flag, or moves the user's flag of the same name. */
export function createFlag(
  game: GameOperationContext,
  userId: string,
  input: CreateFlagInput,
): void {
  const { state } = game;
  const { x, y, name, color, secondaryColor } = input;
  if (
    !isRoomCoordinate(x) ||
    !isRoomCoordinate(y) ||
    name === undefined ||
    !name.length ||
    name.length > 60 ||
    !isFlagColor(color) ||
    !isFlagColor(secondaryColor)
  ) {
    throw new GameError('invalid params');
  }
  const room = checkGameRoom(state.world, input.room, game.now());
  const flags = userFlags(state.world, userId);
  const previousRoom = [...flags].find(([, list]) => list.some((flag) => flag[0] === name))?.[0];
  let count = 0;
  for (const [flagRoom, list] of flags) {
    const kept = flagRoom === previousRoom ? list.filter((flag) => flag[0] !== name) : list;
    flags.set(flagRoom, kept);
    count += kept.length;
  }
  if (count >= C.FLAGS_LIMIT) {
    throw new GameError('flags limit exceeded');
  }
  if (previousRoom !== undefined && previousRoom !== room) {
    saveRoomFlags(state, userId, previousRoom, flags.get(previousRoom) ?? []);
  }
  const flag: FlagEntry = [name, String(color), String(secondaryColor), String(x), String(y)];
  saveRoomFlags(state, userId, room, [...(flags.get(room) ?? []), flag]);
}

/** First free `FlagN` name of a user. */
export function uniqueFlagName(world: WorldState, userId: string): string {
  const names = new Set([...userFlags(world, userId).values()].flat().map((flag) => flag[0]));
  let counter = 1;
  while (names.has(`Flag${String(counter)}`)) {
    counter++;
  }
  return `Flag${String(counter)}`;
}

/** Throws `name exists` when the user already has a flag of this name. */
export function checkUniqueFlagName(world: WorldState, userId: string, name?: string): void {
  for (const list of userFlags(world, userId).values()) {
    if (list.some((flag) => flag[0] === name)) {
      throw new GameError('name exists');
    }
  }
}

export function changeFlagColor(
  state: GameState,
  userId: string,
  input: ChangeFlagColorInput,
): void {
  const { room, name, color, secondaryColor } = input;
  if (!isFlagColor(color) || !isFlagColor(secondaryColor) || room === undefined) {
    throw new GameError('invalid params');
  }
  const flags = userFlags(state.world, userId).get(room) ?? [];
  const flag = flags.find((item) => item[0] === name);
  if (flag) {
    flag[1] = String(color);
    flag[2] = String(secondaryColor);
    saveRoomFlags(state, userId, room, flags);
  }
}

export function removeFlag(state: GameState, userId: string, input: RemoveFlagInput): void {
  const { room, name } = input;
  if (room === undefined) {
    throw new GameError('invalid params');
  }
  const flags = userFlags(state.world, userId).get(room) ?? [];
  const kept = flags.filter((flag) => flag[0] !== name);
  if (kept.length !== flags.length) {
    saveRoomFlags(state, userId, room, kept);
  }
}
