import { constants as C, storeIntents } from '@openscreeps/engine';
import { GameError, type GameState, type RoomObject } from '../contracts.ts';
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

/** Room-level intents the room processor handles (`processRoomIntents`). */
const ROOM_INTENTS: Readonly<Record<string, true>> = {
  removeFlag: true,
  createFlag: true,
  createConstructionSite: true,
  removeConstructionSite: true,
  destroyStructure: true,
};

/**
 * Global intents accepted from players outside their code: power creep account actions and the
 * market, which the global processor fully validates. Account intents (`generatePixel`, `unlockCpu`,
 * `activateAccess`) are excluded because only the runtime charges their cost (CPU bucket) before
 * recording them.
 */
const GLOBAL_INTENTS: Readonly<Record<string, true>> = {
  spawnPowerCreep: true,
  suicidePowerCreep: true,
  deletePowerCreep: true,
  upgradePowerCreep: true,
  createPowerCreep: true,
  renamePowerCreep: true,
  createOrder: true,
  changeOrderPrice: true,
  extendOrder: true,
  cancelOrder: true,
  deal: true,
};

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/**
 * Sanitizes `{[name]: intent}` for one room object exactly like upstream
 * `sanitizeUserIntents({[name]: intent})`, using the engine's stored-intent schema.
 */
function sanitizeObjectIntent(
  room: string,
  objectId: string,
  name: string,
  intent: unknown,
): Record<string, unknown> {
  const stored = storeIntents({ [objectId]: { [name]: intent } }, () => room);
  const sanitized: Readonly<Record<string, unknown>> = stored.rooms[room]?.[objectId] ?? {};
  if (!Object.hasOwn(sanitized, name)) {
    throw new GameError('invalid params');
  }
  return { [name]: sanitized[name] };
}

/**
 * Sanitizes a list of room-level intents element by element (keeping their order). Every element
 * must name `room` as its `roomName` before it reaches the engine sanitizer: the processors create
 * flags and construction sites in `intent.roomName`, so a foreign room name would escape the room
 * whose ownership was validated, and the sanitizer groups by that name with plain property writes.
 */
function sanitizeRoomIntents(room: string, name: string, intents: unknown): unknown[] {
  if (!Object.hasOwn(ROOM_INTENTS, name) || !Array.isArray(intents) || !intents.length) {
    throw new GameError('invalid params');
  }
  return (intents as readonly unknown[]).map((intent) => {
    if (
      typeof intent !== 'object' ||
      intent === null ||
      !('roomName' in intent) ||
      intent.roomName !== room
    ) {
      throw new GameError('invalid params');
    }
    const stored = storeIntents({ room: { [name]: [intent] } }, () => undefined);
    const bucket: Readonly<Record<string, unknown>> | undefined = stored.rooms[room]?.['room'];
    const [sanitized] = listOf(bucket?.[name]);
    if (sanitized === undefined) {
      throw new GameError('invalid params');
    }
    return sanitized;
  });
}

/**
 * Queues manual object intents for the next tick (upstream `rooms.intents` `objectsManual` merge):
 * one payload per intent name per object, the latest request winning, while room-level intent
 * lists accumulate so several clicks within one tick are all processed.
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
  const previous: Readonly<Record<string, unknown>> = targets[targetId] ?? {};
  const merged: Record<string, unknown> = { ...previous };
  for (const [name, payload] of Object.entries(intents)) {
    merged[name] = targetId === 'room' ? [...listOf(previous[name]), ...listOf(payload)] : payload;
  }
  targets[targetId] = merged;
  users[userId] = targets;
  rooms[room] = users;
  state.pendingIntents = rooms;
}

/**
 * Manual safe mode bypasses the runtime's `Controller.activateSafeMode` checks, so they are
 * repeated here: one room in safe mode per player (counting activations already queued for this
 * tick), and the controller conditions the processor enforces.
 */
function checkManualSafeMode(state: GameState, userId: string, controller: RoomObject): void {
  const { world, pendingIntents } = state;
  const gameTime = world.gameTime;
  const queuedElsewhere = Object.values(pendingIntents).some((byUser) =>
    Object.entries(byUser[userId] ?? {}).some(
      ([targetId, intents]) => targetId !== controller._id && intents.activateSafeMode,
    ),
  );
  if (
    queuedElsewhere ||
    Object.values(world.roomObjects).some(
      (object) =>
        object.type === 'controller' && object.user === userId && (object.safeMode ?? 0) > gameTime,
    )
  ) {
    throw new GameError('safe mode active already');
  }
  if (controller.type !== 'controller' || !controller.level) {
    throw new GameError('invalid object');
  }
  if (!((controller.safeModeAvailable ?? 0) > 0)) {
    throw new GameError('no safe mode available');
  }
  if (
    (controller.safeModeCooldown ?? 0) >= gameTime ||
    (controller.upgradeBlocked ?? 0) > gameTime
  ) {
    throw new GameError('safe mode cooldown');
  }
  const downgrade = ownValue<number>(C.CONTROLLER_DOWNGRADE, String(controller.level)) ?? 0;
  if (
    (controller.downgradeTime ?? 0) <
    gameTime + downgrade / 2 - C.CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD
  ) {
    throw new GameError('controller downgrading');
  }
}

/**
 * Upstream `/add-object-intent`: queues a sanitized manual intent for an object the user owns (or
 * whose room controller they own), or room-level intents, and activates the room for next tick.
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
  if (name === undefined || targetId === undefined) {
    throw new GameError('invalid params');
  }
  if (targetId === 'room') {
    queueManualIntents(state, room, userId, 'room', {
      [name]: sanitizeRoomIntents(room, name, intent),
    });
  } else {
    const object = ownValue(world.roomObjects, targetId);
    if (!object || object.room !== room) {
      throw new GameError('invalid object');
    }
    const owner = object.user ?? roomController(world, room)?.user;
    if (owner !== userId) {
      throw new GameError('not owner');
    }
    const sanitized = sanitizeObjectIntent(room, object._id, name, intent);
    if (name === 'activateSafeMode') {
      checkManualSafeMode(state, userId, object);
    }
    queueManualIntents(state, room, userId, object._id, sanitized);
  }
  activateRoom(world, room);
}

/**
 * Upstream `/add-global-intent`: queues one sanitized power creep or market intent (upstream
 * inserts one `users.intents` document per request).
 */
export function addGlobalIntent(state: GameState, userId: string, input: GlobalIntentInput): void {
  const { name } = input;
  if (name === undefined || !Object.hasOwn(GLOBAL_INTENTS, name)) {
    throw new GameError('invalid params');
  }
  const stored = storeIntents({ global: { [name]: [input.intent] } }, () => undefined);
  const global: Readonly<Record<string, unknown>> = stored.global ?? {};
  const intents = listOf(global[name]);
  if (intents.length !== 1) {
    throw new GameError('invalid params');
  }
  const previous: Readonly<Record<string, unknown>> = state.pendingGlobalIntents[userId] ?? {};
  const merged: Record<string, unknown> = {
    ...previous,
    [name]: [...listOf(previous[name]), ...intents],
  };
  state.pendingGlobalIntents = {
    ...state.pendingGlobalIntents,
    [userId]: merged,
  };
}
