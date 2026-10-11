import { constants as C, worldConstants, type WorldState } from '@openscreeps/engine';
import { GameError, newId, type RoomObject } from '../contracts.ts';
import { activateRoom, roomObjectsOf } from '../world/rooms.ts';
import {
  checkGameRoom,
  hasTerrain,
  isRoomCoordinate,
  ownValue,
  roomController,
  type GameOperationContext,
} from './support.ts';

export interface ConstructionSiteInput {
  room?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  structureType?: string | undefined;
  /** Spawn name; required for spawn sites. */
  name?: string | undefined;
}

/** Structures upstream `checkConstructionSpot` refuses to share a tile with (except ramparts). */
const SPOT_BLOCKERS: Readonly<Record<string, true>> = {
  wall: true,
  constructedWall: true,
  spawn: true,
  extension: true,
  link: true,
  storage: true,
  tower: true,
  observer: true,
  powerSpawn: true,
};

/**
 * Upstream `checkConstructionSpot`: inside the room edge, an extractor only on a mineral (whatever
 * else is there), anything else not on a structure of its own type, a construction site or a
 * blocking structure (ramparts excepted), not on a wall (roads excepted), not next to an exit and,
 * on the tiles next to the room edge, only beside edge walls (roads and containers excepted).
 */
export function checkConstructionSpot(
  world: WorldState,
  room: string,
  structureType: string,
  x: number,
  y: number,
): void {
  if (x <= 0 || y <= 0 || x >= 49 || y >= 49) {
    throw new GameError('invalid location');
  }
  const objects = roomObjectsOf(world, room);
  const here = objects.filter((object) => object.x === x && object.y === y);
  if (structureType === 'extractor') {
    if (!here.some((object) => object.type === 'mineral')) {
      throw new GameError('invalid location');
    }
    return;
  }
  const terrain = world.terrain[room] ?? '';
  const blocked =
    here.some((object) => object.type === structureType || object.type === 'constructionSite') ||
    (structureType !== 'rampart' &&
      here.some((object) => Object.hasOwn(SPOT_BLOCKERS, object.type))) ||
    (structureType !== 'road' && hasTerrain(terrain, x, y, C.TERRAIN_MASK_WALL)) ||
    objects.some(
      (object) =>
        object.type === 'exit' && Math.abs(object.x - x) < 2 && Math.abs(object.y - y) < 2,
    );
  if (blocked) {
    throw new GameError('invalid location');
  }
  if (structureType !== 'road' && structureType !== 'container') {
    let borderTiles: Array<[number, number]> = [];
    if (x === 1) {
      borderTiles = [
        [0, y - 1],
        [0, y],
        [0, y + 1],
      ];
    }
    if (x === 48) {
      borderTiles = [
        [49, y - 1],
        [49, y],
        [49, y + 1],
      ];
    }
    if (y === 1) {
      borderTiles = [
        [x - 1, 0],
        [x, 0],
        [x + 1, 0],
      ];
    }
    if (y === 48) {
      borderTiles = [
        [x - 1, 49],
        [x, 49],
        [x + 1, 49],
      ];
    }
    if (borderTiles.some(([bx, by]) => !hasTerrain(terrain, bx, by, C.TERRAIN_MASK_WALL))) {
      throw new GameError('invalid location');
    }
  }
}

/** Upstream `checkController(room, 'construct')`: owner/reservation and the RCL structure limit. */
function checkConstructionController(
  world: WorldState,
  room: string,
  structureType: string,
  userId: string,
): void {
  const controller = roomController(world, room);
  if (
    controller &&
    ((controller.user && controller.user !== userId) ||
      (controller.reservation && controller.reservation.user !== userId))
  ) {
    throw new GameError('not a controller owner');
  }
  const rcl = controller?.level && controller.user ? controller.level : 0;
  const count = roomObjectsOf(world, room).filter(
    (object) =>
      object.type === structureType ||
      (object.type === 'constructionSite' && object.structureType === structureType),
  ).length;
  const controllerStructures: Readonly<Record<string, Readonly<Record<number, number>>>> =
    worldConstants(world).CONTROLLER_STRUCTURES;
  const available = ownValue(controllerStructures, structureType)?.[rcl];
  if (available === undefined || count >= available) {
    throw new GameError('RCL not enough');
  }
}

/** Upstream `/create-construction`: places a construction site for the user. */
export function createConstructionSite(
  game: GameOperationContext,
  userId: string,
  input: ConstructionSiteInput,
): RoomObject {
  const { state } = game;
  const { world } = state;
  const C = worldConstants(world);
  const constructionCost: Readonly<Record<string, number>> = C.CONSTRUCTION_COST;
  const { x, y, structureType, name } = input;
  if (
    !isRoomCoordinate(x) ||
    !isRoomCoordinate(y) ||
    structureType === undefined ||
    !Object.hasOwn(constructionCost, structureType) ||
    (name !== undefined && name.length > 50) ||
    (structureType === 'spawn' && !name)
  ) {
    throw new GameError('invalid params');
  }
  const room = checkGameRoom(world, input.room, game.now());
  checkConstructionSpot(world, room, structureType, x, y);
  checkConstructionController(world, room, structureType, userId);
  let progressTotal = constructionCost[structureType] ?? 0;
  if (structureType === 'road') {
    const terrain = world.terrain[room] ?? '';
    if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_SWAMP)) {
      progressTotal *= C.CONSTRUCTION_COST_ROAD_SWAMP_RATIO;
    }
    if (hasTerrain(terrain, x, y, C.TERRAIN_MASK_WALL)) {
      progressTotal *= C.CONSTRUCTION_COST_ROAD_WALL_RATIO;
    }
  }
  const sites = Object.values(world.roomObjects).filter(
    (object) => object.type === 'constructionSite' && object.user === userId,
  ).length;
  if (sites >= C.MAX_CONSTRUCTION_SITES) {
    throw new GameError('too many');
  }
  const site: RoomObject = {
    _id: newId(state),
    type: 'constructionSite',
    room,
    x,
    y,
    structureType,
    user: userId,
    progress: 0,
    progressTotal,
  };
  if (name) {
    site.name = name;
  }
  world.roomObjects[site._id] = site;
  activateRoom(world, room);
  return site;
}
