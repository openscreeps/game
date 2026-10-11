import { worldConstants, type WorldState } from '@openscreeps/engine';
import { GameError, newId, type GameState } from '../contracts.ts';
import { checkGameRoom, isFlagColor, type GameOperationContext } from './support.ts';

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

/**
 * All flags of a user by room (upstream `getFlags(user)`: one entry per room document, a later
 * document of the same room replacing an earlier one).
 */
export function userFlags(world: WorldState, userId: string): Map<string, FlagEntry[]> {
  const rooms = new Map<string, FlagEntry[]>();
  for (const doc of Object.values(world.flags)) {
    if (doc.user === userId) {
      rooms.set(doc.room, parseFlags(doc.data));
    }
  }
  return rooms;
}

/** Flags of a user in one room (upstream `getFlags(user, room)`: the first matching document). */
function roomFlags(world: WorldState, userId: string, room: string): FlagEntry[] {
  const doc = Object.values(world.flags).find((item) => item.user === userId && item.room === room);
  return doc ? parseFlags(doc.data) : [];
}

/**
 * Upstream `setFlags`: `update({user, room}, {$set: {data}}, {upsert: true})`. Every document of
 * the user and room gets the serialized flags (with the separator escapes the engine and runtime
 * parse); without one a document is inserted, also for an empty room (`data: ''`).
 */
function saveRoomFlags(
  state: GameState,
  userId: string,
  room: string,
  flags: readonly FlagEntry[],
): void {
  const data = flags
    .map(([name = '', ...rest]) =>
      [name.replace(/\|/g, '$VLINE$').replace(/~/g, '$TILDE$'), ...rest].join('~'),
    )
    .join('|');
  const docs: FlagDoc[] = Object.values(state.world.flags).filter(
    (doc) => doc.user === userId && doc.room === room,
  );
  for (const doc of docs) {
    doc.data = data;
  }
  if (!docs.length) {
    const _id = newId(state);
    state.world.flags[_id] = { _id, user: userId, room, data };
  }
}

/**
 * Upstream `/create-flag`: creates a flag, or moves the user's flag of the same name. The old flag
 * is removed (and saved) before the flag limit is checked, so a refused move still drops it.
 * Coordinates are any numbers within 0..49 (upstream `_.isNumber`), stored as given.
 */
export function createFlag(
  game: GameOperationContext,
  userId: string,
  input: CreateFlagInput,
): void {
  const { state } = game;
  const C = worldConstants(state.world);
  const { x, y, name, color, secondaryColor } = input;
  if (
    typeof x !== 'number' ||
    x < 0 ||
    x > 49 ||
    typeof y !== 'number' ||
    y < 0 ||
    y > 49 ||
    name === undefined ||
    name.length > 60 ||
    !isFlagColor(color, C) ||
    !isFlagColor(secondaryColor, C)
  ) {
    throw new GameError('invalid params');
  }
  const room = checkGameRoom(state.world, input.room, game.now());
  const previous = [...userFlags(state.world, userId)].find(([, list]) =>
    list.some((flag) => flag[0] === name),
  );
  if (previous) {
    const [previousRoom, list] = previous;
    saveRoomFlags(
      state,
      userId,
      previousRoom,
      list.filter((flag) => flag[0] !== name),
    );
  }
  const flags = userFlags(state.world, userId);
  const count = [...flags.values()].reduce((sum, list) => sum + list.length, 0);
  if (count >= C.FLAGS_LIMIT) {
    throw new GameError('flags limit exceeded');
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

/**
 * Upstream `/change-flag-color`: recolors the named flag of the room and saves the room's flags
 * (creating an empty room document when there is none). Without a room nothing is saved.
 */
export function changeFlagColor(
  state: GameState,
  userId: string,
  input: ChangeFlagColorInput,
): void {
  const { room, name, color, secondaryColor } = input;
  const C = worldConstants(state.world);
  if (!isFlagColor(color, C) || !isFlagColor(secondaryColor, C)) {
    throw new GameError('invalid params');
  }
  if (!room) {
    return;
  }
  const flags = roomFlags(state.world, userId, room);
  const flag = flags.find((item) => item[0] === name);
  if (flag) {
    flag[1] = String(color);
    flag[2] = String(secondaryColor);
  }
  saveRoomFlags(state, userId, room, flags);
}

/**
 * Upstream `/remove-flag`: saves the room's flags without the named one (creating an empty room
 * document when there is none). Without a room nothing is saved.
 */
export function removeFlag(state: GameState, userId: string, input: RemoveFlagInput): void {
  const { room, name } = input;
  if (!room) {
    return;
  }
  const flags = roomFlags(state.world, userId, room);
  saveRoomFlags(
    state,
    userId,
    room,
    flags.filter((flag) => flag[0] !== name),
  );
}
