import { storeIntents } from '@openscreeps/engine';
import { GameError, type GameState } from '../contracts.ts';
import { isRecord } from '../guards.ts';
import { activateRoom } from '../world/rooms.ts';
import { checkGameRoom, ownValue, roomController, type GameOperationContext } from './support.ts';

export interface ObjectIntentInput {
  room?: string | undefined;
  /** Target room object id, or `room` for room-level intents. */
  targetId?: string | undefined;
  name?: string | undefined;
  intent: unknown;
}

export interface GlobalIntentInput {
  name?: string | undefined;
  intent: unknown;
}

/** Room-level intents the room processor iterates as lists (`processRoomIntents`). */
const ROOM_LIST_INTENTS: Readonly<Record<string, true>> = {
  removeFlag: true,
  createFlag: true,
  createConstructionSite: true,
  removeConstructionSite: true,
  destroyStructure: true,
};

/**
 * Official-game account intents the engine knows but the pinned backend's `sanitizeUserIntents`
 * does not: upstream drops them. Only the runtime may record them, because only it charges their
 * cost (CPU bucket) first.
 */
const UNKNOWN_UPSTREAM_INTENTS: Readonly<Record<string, true>> = {
  generatePixel: true,
  unlockCpu: true,
  activateAccess: true,
};

/** Placeholder object id for sanitizing one payload through the engine's stored-intent schema. */
const SANITIZE_KEY = 'intent';

/**
 * Upstream `sanitizeIntent(name, payload)` for one single (non-list) payload, through the engine's
 * schema; `undefined` for intents the pinned backend does not know. The result is JSON
 * round-tripped as the backend's storage RPC does (`NaN` becomes `null`, `undefined` fields drop).
 */
function sanitizePayload(name: string, payload: unknown): unknown {
  if (Object.hasOwn(UNKNOWN_UPSTREAM_INTENTS, name)) {
    return undefined;
  }
  const stored = storeIntents({ [SANITIZE_KEY]: { [name]: payload } }, () => SANITIZE_KEY);
  const sanitized: Readonly<Record<string, unknown>> =
    stored.rooms[SANITIZE_KEY]?.[SANITIZE_KEY] ?? {};
  const value = ownValue(sanitized, name);
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * Upstream `sanitizeUserIntents({[name]: payload})` for a manual object or room intent: a falsy
 * payload or unknown intent yields `{}`, a list is sanitized element by element.
 *
 * Payload shapes the processor cannot survive are refused (`invalid params`): it reads single
 * object intents as objects (a list would make e.g. `createCreep` call `undefined.slice`) and
 * iterates the room-level ones with `forEach` (a single object would throw). Upstream stores both
 * and its room processor then throws for every player in that room. Room-level list entries must
 * also name the target room: their processors create flags and construction sites in
 * `intent.roomName`, so a foreign room would escape the room the intent was queued for.
 */
function sanitizeManualIntent(
  room: string,
  targetId: string,
  name: string | undefined,
  payload: unknown,
): Record<string, unknown> {
  if (name === undefined || !payload) {
    return {};
  }
  const roomList = targetId === 'room' && Object.hasOwn(ROOM_LIST_INTENTS, name);
  if (Array.isArray(payload) ? targetId !== 'room' : roomList) {
    throw new GameError('invalid params');
  }
  if (!Array.isArray(payload)) {
    const sanitized = sanitizePayload(name, payload);
    return sanitized === undefined ? {} : { [name]: sanitized };
  }
  const list = (payload as readonly unknown[]).map((item) => {
    // upstream throws on `null`/`undefined` entries (`intent[field]`) and stores nothing
    if (
      item === null ||
      item === undefined ||
      (roomList && (!isRecord(item) || item.roomName !== room))
    ) {
      throw new GameError('invalid params');
    }
    return sanitizePayload(name, item);
  });
  return list.includes(undefined) ? {} : { [name]: list };
}

/**
 * lodash 3 `_.merge` of JSON values, as the backend's storage applies `$merge`: plain objects and
 * arrays merge recursively (arrays index by index), `undefined` never overwrites.
 */
function mergeInto(target: Record<string, unknown> | unknown[], source: unknown): void {
  const entries: Array<[string | number, unknown]> = Array.isArray(source)
    ? source.map((value, index): [number, unknown] => [index, value])
    : isRecord(source)
      ? Object.entries(source)
      : [];
  for (const [key, value] of entries) {
    const current: unknown = Reflect.get(target, key);
    let next: unknown = value;
    if (Array.isArray(value)) {
      next = Array.isArray(current) ? current : [];
      mergeInto(next as unknown[], value);
    } else if (isRecord(value)) {
      next = isRecord(current) ? current : {};
      mergeInto(next as Record<string, unknown>, value);
    } else if (value === undefined) {
      continue;
    }
    Reflect.defineProperty(target, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/**
 * Queues manual object intents for the next tick exactly like upstream's `rooms.intents` update
 * `{$merge: {users: {[user]: {objectsManual: {[target]: intents}}}}}`: payloads deep-merge into
 * what is already queued for the target (lists index by index, so a later room-level list
 * overwrites the earlier one's leading entries).
 */
function queueManualIntents(
  state: GameState,
  room: string,
  userId: string,
  targetId: string,
  intents: Readonly<Record<string, unknown>>,
): void {
  const rooms = { ...state.pendingIntents };
  const users = { ...rooms[room] };
  const targets = { ...users[userId] };
  const merged: Record<string, unknown> = structuredClone(targets[targetId] ?? {});
  mergeInto(merged, intents);
  targets[targetId] = merged;
  users[userId] = targets;
  rooms[room] = users;
  state.pendingIntents = rooms;
}

/**
 * Upstream `/add-object-intent`: queues a sanitized manual intent and activates the room for the
 * next tick. `activateSafeMode` is refused while one of the player's rooms is in safe mode (the
 * processor checks the controller itself).
 *
 * Unlike upstream, object intents are only accepted for objects in that room the player owns (or,
 * for unowned structures, whose room controller the player owns): the processor skips other
 * players' objects but runs intents of unowned ones (e.g. `send` from an NPC terminal).
 */
export function addObjectIntent(
  game: GameOperationContext,
  userId: string,
  input: ObjectIntentInput,
): void {
  const { state } = game;
  const { world } = state;
  const room = checkGameRoom(world, input.room, game.now());
  const { targetId, name, intent } = input;
  if (name === 'activateSafeMode') {
    const gameTime = world.gameTime;
    const active = Object.values(world.roomObjects).some(
      (object) =>
        object.type === 'controller' && object.user === userId && (object.safeMode ?? 0) > gameTime,
    );
    if (active) {
      throw new GameError('safe mode active already');
    }
  }
  if (targetId === undefined) {
    throw new GameError('invalid object');
  }
  if (targetId !== 'room') {
    const object = ownValue(world.roomObjects, targetId);
    if (!object || object.room !== room) {
      throw new GameError('invalid object');
    }
    const owner = object.user ?? roomController(world, room)?.user;
    if (owner !== userId) {
      throw new GameError('not owner');
    }
  }
  const intents = sanitizeManualIntent(room, targetId, name, intent);
  queueManualIntents(state, room, userId, targetId, intents);
  activateRoom(world, room);
}

/**
 * Upstream `/add-global-intent`: queues one sanitized global intent (upstream inserts one
 * `users.intents` document per request, `{}` for an unknown intent).
 */
export function addGlobalIntent(state: GameState, userId: string, input: GlobalIntentInput): void {
  const { name } = input;
  const merged: Record<string, unknown> = { ...state.pendingGlobalIntents[userId] };
  if (name !== undefined && !Object.hasOwn(UNKNOWN_UPSTREAM_INTENTS, name)) {
    const stored = storeIntents({ global: { [name]: [input.intent] } }, () => undefined);
    const list = ownValue<unknown>(stored.global ?? {}, name);
    if (Array.isArray(list)) {
      const queued = merged[name];
      merged[name] = [
        ...(Array.isArray(queued) ? (queued as unknown[]) : []),
        ...(JSON.parse(JSON.stringify(list)) as unknown[]),
      ];
    }
  }
  state.pendingGlobalIntents = {
    ...state.pendingGlobalIntents,
    [userId]: merged,
  };
}
