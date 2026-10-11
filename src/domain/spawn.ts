import { recordRoomObjectWrites, worldConstants, type WorldState } from '@openscreeps/engine';
import { GameError, newId, type RoomObject } from '../contracts.ts';
import { activateRoom, roomObjectsOf, storageIndexOrder } from '../world/rooms.ts';
import { checkConstructionSpot } from './construction.ts';
import {
  checkGameRoom,
  gameUser,
  isRoomCoordinate,
  roomController,
  type GameOperationContext,
} from './support.ts';

export interface PlaceSpawnInput {
  room?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  name?: string | undefined;
}

export interface ObjectNameInput {
  type?: string | undefined;
  name?: string | undefined;
}

const RESPAWN_COOLDOWN = 180000;
const PLACE_SPAWN_SAFE_MODE = 20000;
const PLACE_SPAWN_RUIN_DECAY = 100000;
const PLACE_SPAWN_INVADER_GOAL = 1000000;
const PLACE_SPAWN_ACTIVE = 10000;

/** Upstream `checkController(room, 'spawn')`: a free, unreserved controller not bound to others. */
function checkSpawnController(world: WorldState, room: string, userId: string): void {
  const controller = roomController(world, room);
  if (!controller) {
    throw new GameError('invalid room');
  }
  if (
    controller.user ||
    controller.reservation ||
    (controller.bindUser && controller.bindUser !== userId)
  ) {
    throw new GameError('room busy');
  }
}

/**
 * Upstream `/place-spawn`: a user without objects starts playing. Other players' creeps and
 * construction sites in the room are removed, their structures become ruins, a level 0 controller
 * is claimed at level 1 with safe mode, the sources reset their invader counters and the first
 * spawn is inserted (unnamed when no name is given).
 */
export function placeSpawn(
  game: GameOperationContext,
  userId: string,
  input: PlaceSpawnInput,
): RoomObject {
  const { state } = game;
  const { world } = state;
  const C = worldConstants(world);
  const { x, y, name } = input;
  if (!isRoomCoordinate(x) || !isRoomCoordinate(y) || (name !== undefined && name.length > 50)) {
    throw new GameError('invalid params');
  }
  const user = gameUser(world, userId);
  if (user.blocked) {
    throw new GameError('blocked');
  }
  if (!user.cpu) {
    throw new GameError('no cpu');
  }
  const now = game.now();
  if (user.lastRespawnDate && now - user.lastRespawnDate < RESPAWN_COOLDOWN) {
    throw new GameError('too soon after last respawn');
  }
  const room = checkGameRoom(world, input.room, now);
  if (Object.values(world.roomObjects).some((object) => object.user === userId)) {
    throw new GameError('already playing');
  }
  checkSpawnController(world, room, userId);
  checkConstructionSpot(world, room, 'spawn', x, y);

  const gameTime = world.gameTime;
  const owned = roomObjectsOf(world, room).filter((object) => object.user);
  for (const object of owned) {
    if (object.type === 'creep' || object.type === 'constructionSite') {
      Reflect.deleteProperty(world.roomObjects, object._id);
    }
  }
  // ruins are inserted in the order the storage returns the structures (room index)
  const structures = owned.filter((object) => Object.hasOwn(C.CONSTRUCTION_COST, object.type));
  for (const id of storageIndexOrder(world, structures)) {
    const object = world.roomObjects[id] as RoomObject;
    const ruinId = newId(state);
    world.roomObjects[ruinId] = {
      _id: ruinId,
      type: 'ruin',
      user: object.user,
      room,
      x: object.x,
      y: object.y,
      structure: {
        id: object._id,
        type: object.type,
        hits: 0,
        hitsMax: object.hitsMax,
        user: object.user,
      },
      store: { ...object.store },
      destroyTime: gameTime,
      decayTime: gameTime + PLACE_SPAWN_RUIN_DECAY,
    };
  }
  for (const object of structures) {
    Reflect.deleteProperty(world.roomObjects, object._id);
  }
  const objects = roomObjectsOf(world, room);
  const controllers = objects.filter((o) => o.type === 'controller' && o.level === 0);
  const controllerIds = storageIndexOrder(world, controllers);
  for (const object of controllers) {
    Object.assign(object, {
      user: userId,
      level: 1,
      progress: 0,
      downgradeTime: null,
      safeMode: gameTime + PLACE_SPAWN_SAFE_MODE,
    });
  }
  recordRoomObjectWrites(world, controllerIds);
  const sources = objects.filter((o) => o.type === 'source');
  const sourceIds = storageIndexOrder(world, sources);
  for (const object of sources) {
    object.invaderHarvested = 0;
  }
  recordRoomObjectWrites(world, sourceIds);
  const spawn: RoomObject = {
    _id: newId(state),
    type: 'spawn',
    room,
    x,
    y,
    user: userId,
    store: { energy: C.SPAWN_ENERGY_START },
    storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
    hits: C.SPAWN_HITS,
    hitsMax: C.SPAWN_HITS,
    spawning: null,
    notifyWhenAttacked: true,
  };
  if (name !== undefined) {
    spawn.name = name;
  }
  world.roomObjects[spawn._id] = spawn;
  const info = world.rooms[room];
  if (info) {
    info.invaderGoal = PLACE_SPAWN_INVADER_GOAL;
  }
  activateRoom(world, room);
  user.active = PLACE_SPAWN_ACTIVE;
  return spawn;
}

/** First free `SpawnN` name among the user's spawns and spawn sites (only `spawn` is supported). */
export function uniqueObjectName(world: WorldState, userId: string, type?: string): string {
  if (type !== 'spawn') {
    throw new GameError('invalid params');
  }
  const objects = Object.values(world.roomObjects).filter(
    (object) =>
      object.user === userId && (object.type === type || object.type === 'constructionSite'),
  );
  let counter = 1;
  while (
    objects.some(
      (object) =>
        (object.type === type || object.structureType === type) &&
        object.name === `Spawn${String(counter)}`,
    )
  ) {
    counter++;
  }
  return `Spawn${String(counter)}`;
}

/** Throws `name exists` when one of the user's spawns or construction sites has this name. */
export function checkUniqueObjectName(
  world: WorldState,
  userId: string,
  input: ObjectNameInput,
): void {
  const { type, name } = input;
  if (type !== 'spawn' || name === undefined) {
    throw new GameError('invalid params');
  }
  const exists = Object.values(world.roomObjects).some(
    (object) =>
      object.user === userId &&
      (object.type === type || object.type === 'constructionSite') &&
      object.name === name,
  );
  if (exists) {
    throw new GameError('name exists');
  }
}
