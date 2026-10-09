import { GameError, newId, type GameState, type RoomObject } from '../contracts.ts';
import { INVADER_BODIES } from '../world/maintenance.ts';
import { WorldRandom } from '../world/random.ts';
import { roomObjectsOf } from '../world/rooms.ts';
import {
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
 * Upstream `/create-invader`: summons an NPC invader into a room the user owns or reserves (any
 * tile, walls included), at most five at a time and only while no other player's creeps are
 * present. The room is not activated.
 *
 * Unlike upstream, which stores the request's `x`/`y` as given (strings, out-of-room numbers), the
 * position must be a room tile: the processor's movement and range arithmetic on a corrupt position
 * would affect every player in the room.
 */
export function createInvader(
  game: GameOperationContext,
  userId: string,
  input: CreateInvaderInput,
): RoomObject {
  const { state } = game;
  const { world } = state;
  const { room, x, y, size, type } = input;
  const creeps =
    room === undefined
      ? []
      : roomObjectsOf(world, room).filter((object) => object.type === 'creep');
  if (creeps.filter((creep) => creep.user === INVADER_USER).length >= INVADER_LIMIT) {
    throw new GameError('too many invaders exist');
  }
  if (creeps.some((creep) => creep.user !== INVADER_USER && creep.user !== userId)) {
    throw new GameError('hostiles present');
  }
  const controller = room === undefined ? undefined : roomController(world, room);
  if (
    room === undefined ||
    !controller ||
    (controller.user !== userId && controller.reservation?.user !== userId)
  ) {
    throw new GameError('not owned');
  }
  const bodyParts =
    size !== undefined && type !== undefined ? ownValue(INVADER_BODIES, size + type) : undefined;
  if (!isRoomCoordinate(x) || !isRoomCoordinate(y) || !bodyParts) {
    throw new GameError('invalid params');
  }
  const body = bodyParts.map((part) => {
    const boost = input.boosted ? ownValue(INVADER_BOOSTS, part) : undefined;
    return boost ? { type: part, hits: 100, boost } : { type: part, hits: 100 };
  });
  const suffix = new WorldRandom(world).index(1000);
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
    name: `invader_${room}_${String(suffix)}`,
    userSummoned: userId,
  };
  world.roomObjects[creep._id] = creep;
  return creep;
}

/** Upstream `/remove-invader`: removes an object the user summoned (the room is not activated). */
export function removeInvader(state: GameState, userId: string, id?: string): void {
  const { world } = state;
  const object = ownValue(world.roomObjects, id);
  if (!object || object.userSummoned !== userId) {
    throw new GameError('invalid object');
  }
  Reflect.deleteProperty(world.roomObjects, object._id);
}
