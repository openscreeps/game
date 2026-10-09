import { constants as C } from '@openscreeps/engine';
import { GameError, newId, type GameState, type RoomObject } from '../contracts.ts';
import { INVADER_BODIES } from '../world/maintenance.ts';
import { activateRoom, roomObjectsOf } from '../world/rooms.ts';
import {
  checkGameRoom,
  hasTerrain,
  isRoomCoordinate,
  ownValue,
  roomController,
  type GameOperationContext,
} from './support.ts';

export interface CreateInvaderInput {
  room?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  /** `big` or `small`. */
  size?: string | undefined;
  /** `Healer`, `Ranged` or `Melee`. */
  type?: string | undefined;
  boosted?: boolean | undefined;
}

/** Boosts of boosted invaders by body part. */
const INVADER_BOOSTS: Readonly<Record<string, string>> = {
  heal: 'LO',
  ranged_attack: 'KO',
  work: 'ZH',
  attack: 'UH',
};

const INVADER_USER = '2';
const INVADER_LIMIT = 5;

/**
 * Upstream `/create-invader`: summons an NPC invader into a room the user owns or reserves, at most
 * five at a time and only while no other player's creeps are present.
 */
export function createInvader(
  game: GameOperationContext,
  userId: string,
  input: CreateInvaderInput,
): RoomObject {
  const { state } = game;
  const { world } = state;
  const room = checkGameRoom(world, input.room, game.now());
  const { x, y, size, type } = input;
  const bodyParts =
    size !== undefined && type !== undefined ? ownValue(INVADER_BODIES, size + type) : undefined;
  if (!isRoomCoordinate(x) || !isRoomCoordinate(y) || !bodyParts) {
    throw new GameError('invalid params');
  }
  const creeps = roomObjectsOf(world, room).filter((object) => object.type === 'creep');
  if (creeps.filter((creep) => creep.user === INVADER_USER).length >= INVADER_LIMIT) {
    throw new GameError('too many invaders exist');
  }
  if (creeps.some((creep) => creep.user !== INVADER_USER && creep.user !== userId)) {
    throw new GameError('hostiles present');
  }
  const controller = roomController(world, room);
  if (!controller || (controller.user !== userId && controller.reservation?.user !== userId)) {
    throw new GameError('not owned');
  }
  if (hasTerrain(world.terrain[room] ?? '', x, y, C.TERRAIN_MASK_WALL)) {
    throw new GameError('invalid location');
  }
  const body = bodyParts.map((part) => {
    const boost = input.boosted ? ownValue(INVADER_BOOSTS, part) : undefined;
    return boost ? { type: part, hits: 100, boost } : { type: part, hits: 100 };
  });
  const creep: RoomObject = {
    _id: newId(state),
    type: 'creep',
    user: INVADER_USER,
    body,
    hits: body.length * 100,
    hitsMax: body.length * 100,
    ticksToLive: 1500,
    x,
    y,
    room,
    fatigue: 0,
    store: {},
    storeCapacity: 0,
    name: `invader_${room}_${String(Math.floor(Math.random() * 1000))}`,
    userSummoned: userId,
  };
  world.roomObjects[creep._id] = creep;
  activateRoom(world, room);
  return creep;
}

/** Upstream `/remove-invader`: removes an invader the user summoned. */
export function removeInvader(state: GameState, userId: string, id?: string): void {
  const { world } = state;
  const object = ownValue(world.roomObjects, id);
  if (!object || object.type !== 'creep' || object.userSummoned !== userId) {
    throw new GameError('invalid object');
  }
  Reflect.deleteProperty(world.roomObjects, object._id);
  activateRoom(world, object.room);
}
