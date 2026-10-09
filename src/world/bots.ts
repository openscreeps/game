/*
 * Bot players and respawn, ported from screeps/backend `lib/cli/bots.js` and `lib/utils.js`
 * (loadBot, reloadBotUsers, respawnUser, getUserWorldStatus).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  constants as C,
  recordRoomObjectWrite,
  recordRoomObjectWrites,
  type CodeModules,
  type WorldState,
} from '@openscreeps/engine';
import { replaceBranches } from '../code.ts';
import { newId, type Badge, type GameContext, type GameState, type User } from '../contracts.ts';
import { findUserByUsername } from '../players.ts';
import { ensureSystemUser } from './generate.ts';
import { WorldRandom } from './random.ts';
import {
  activateRoom,
  insertObject,
  isWallAt,
  storageIndexOrder,
  type RoomObject,
} from './rooms.ts';

const BOY_NAMES = [
  'Jackson',
  'Aiden',
  'Liam',
  'Lucas',
  'Noah',
  'Mason',
  'Jayden',
  'Ethan',
  'Jacob',
  'Jack',
  'Caden',
  'Logan',
  'Benjamin',
  'Michael',
  'Caleb',
  'Ryan',
  'Alexander',
  'Elijah',
  'James',
  'William',
  'Oliver',
  'Connor',
  'Matthew',
  'Daniel',
  'Luke',
  'Brayden',
  'Jayce',
  'Henry',
  'Carter',
  'Dylan',
  'Gabriel',
  'Joshua',
  'Nicholas',
  'Isaac',
  'Owen',
  'Nathan',
  'Grayson',
  'Eli',
  'Landon',
  'Andrew',
  'Max',
  'Samuel',
  'Gavin',
  'Wyatt',
  'Christian',
  'Hunter',
  'Cameron',
  'Evan',
  'Charlie',
  'David',
  'Sebastian',
  'Joseph',
  'Dominic',
  'Anthony',
  'Colton',
  'John',
  'Tyler',
  'Zachary',
  'Thomas',
  'Julian',
  'Levi',
  'Adam',
  'Isaiah',
  'Alex',
  'Aaron',
  'Parker',
  'Cooper',
  'Miles',
  'Chase',
  'Muhammad',
  'Christopher',
  'Blake',
  'Austin',
  'Jordan',
  'Leo',
  'Jonathan',
  'Adrian',
  'Colin',
  'Hudson',
  'Ian',
  'Xavier',
  'Camden',
  'Tristan',
  'Carson',
  'Jason',
  'Nolan',
  'Riley',
  'Lincoln',
  'Brody',
  'Bentley',
  'Nathaniel',
  'Josiah',
  'Declan',
  'Jake',
  'Asher',
  'Jeremiah',
  'Cole',
  'Mateo',
  'Micah',
  'Elliot',
];
const GIRL_NAMES = [
  'Sophia',
  'Emma',
  'Olivia',
  'Isabella',
  'Mia',
  'Ava',
  'Lily',
  'Zoe',
  'Emily',
  'Chloe',
  'Layla',
  'Madison',
  'Madelyn',
  'Abigail',
  'Aubrey',
  'Charlotte',
  'Amelia',
  'Ella',
  'Kaylee',
  'Avery',
  'Aaliyah',
  'Hailey',
  'Hannah',
  'Addison',
  'Riley',
  'Harper',
  'Aria',
  'Arianna',
  'Mackenzie',
  'Lila',
  'Evelyn',
  'Adalyn',
  'Grace',
  'Brooklyn',
  'Ellie',
  'Anna',
  'Kaitlyn',
  'Isabelle',
  'Sophie',
  'Scarlett',
  'Natalie',
  'Leah',
  'Sarah',
  'Nora',
  'Mila',
  'Elizabeth',
  'Lillian',
  'Kylie',
  'Audrey',
  'Lucy',
  'Maya',
  'Annabelle',
  'Makayla',
  'Gabriella',
  'Elena',
  'Victoria',
  'Claire',
  'Savannah',
  'Peyton',
  'Maria',
  'Alaina',
  'Kennedy',
  'Stella',
  'Liliana',
  'Allison',
  'Samantha',
  'Keira',
  'Alyssa',
  'Reagan',
  'Molly',
  'Alexandra',
  'Violet',
  'Charlie',
  'Julia',
  'Sadie',
  'Ruby',
  'Eva',
  'Alice',
  'Eliana',
  'Taylor',
  'Callie',
  'Penelope',
  'Camilla',
  'Bailey',
  'Kaelyn',
  'Alexis',
  'Kayla',
  'Katherine',
  'Sydney',
  'Lauren',
  'Jasmine',
  'London',
  'Bella',
  'Adeline',
  'Caroline',
  'Vivian',
  'Juliana',
  'Gianna',
  'Skyler',
  'Jordyn',
];

/**
 * Upstream `utils.loadBot`: the `*.js` files of a bot AI directory as code modules (`main.js`
 * required). Module names keep their dots (`role.harvester.js` -> `role.harvester`).
 */
export function loadBotModules(directory: string): CodeModules {
  if (!statSync(directory).isDirectory()) {
    throw new Error(`"${directory}" is not a directory`);
  }
  statSync(resolve(directory, 'main.js'));
  const modules: CodeModules = {};
  for (const file of readdirSync(directory)) {
    const match = /^(.*)\.js$/.exec(file);
    if (match?.[1] !== undefined) {
      modules[match[1]] = readFileSync(resolve(directory, file), { encoding: 'utf8' });
    }
  }
  return modules;
}

/**
 * Upstream `genRandomUserName`. Names are checked case-insensitively (upstream: exact match), so a
 * generated bot can never share a lower-case name with another player.
 */
function genRandomUserName(state: GameState, random: WorldRandom): string {
  for (let c = 0; ; c++) {
    const list = random.next() > 0.5 ? BOY_NAMES : GIRL_NAMES;
    let name = list[random.index(list.length)] as string;
    if (c > 3) {
      name += list[random.index(list.length)] as string;
    }
    if (!findUserByUsername(state, `${name}Bot`)) {
      return `${name}Bot`;
    }
  }
}

function genRandomBadge(random: WorldRandom): Badge {
  const color = (): string => `#${Math.floor(random.next() * 0xffffff).toString(16)}`;
  return {
    type: random.index(24) + 1,
    color1: color(),
    color2: color(),
    color3: color(),
    flip: random.next() > 0.5,
    param: random.index(200) - 100,
  };
}

export interface SpawnBotOptions {
  /** Bot player name; default (also for `''`) randomly generated `<Name>Bot`. */
  username?: string;
  /** CPU limit; default (also for `0`) 100. */
  cpu?: number;
  /** Global Control Level; default 1. */
  gcl?: number;
  /** Spawn position (0..49); default (also for `0`) a random non-wall tile in 3..48. */
  x?: number;
  y?: number;
}

/**
 * Upstream `bots.spawn`: create an NPC player running `modules` and give it a spawn and the
 * controller of an unowned room. Draws the name, the badge and then the spawn position like
 * upstream. Usernames are unique case-insensitively (upstream compares them exactly), the only
 * deliberate difference. Lock-held; returns the new user id and name.
 */
export function spawnBot(
  context: GameContext,
  botAiName: string,
  modules: CodeModules,
  roomName: string,
  options: SpawnBotOptions = {},
): { userId: string; username: string } {
  const { state } = context;
  const world = state.world;
  const random = new WorldRandom(world);
  const controller = Object.values(world.roomObjects).find(
    (o) => o.room === roomName && o.type === 'controller',
  );
  if (!controller) {
    throw new Error(`Room controller not found in ${roomName}`);
  }
  if (controller.user) {
    throw new Error(`Room ${roomName} is already owned`);
  }
  const terrain = world.terrain[roomName];
  if (terrain === undefined) {
    throw new Error(`Room terrain not found in ${roomName}`);
  }
  for (const coord of [options.x, options.y]) {
    if (coord !== undefined && (!Number.isInteger(coord) || coord < 0 || coord > 49)) {
      throw new Error(`Invalid spawn position ${String(coord)}`);
    }
  }
  let username: string;
  if (options.username) {
    if (findUserByUsername(state, options.username)) {
      throw new Error(`User with the name "${options.username}" already exists`);
    }
    username = options.username;
  } else {
    username = genRandomUserName(state, random);
  }
  // upstream bot user document (no money/rooms; registration date is host account data)
  const user: User = {
    _id: newId(state),
    username,
    usernameLower: username.toLowerCase(),
    cpu: options.cpu || 100,
    gcl: options.gcl ? C.GCL_MULTIPLY * Math.pow(options.gcl - 1, C.GCL_POW) : 0,
    cpuAvailable: 0,
    bot: botAiName,
    active: 10000,
    badge: genRandomBadge(random),
  };
  world.users[user._id] = user;
  const code = structuredClone(modules);
  if (code.main === undefined) code.main = '';
  const branchId = newId(state);
  state.branches[branchId] = {
    _id: branchId,
    user: user._id,
    branch: 'default',
    modules: code,
    activeWorld: true,
    activeSim: true,
  };
  context.runtime.setCode(user._id, code, 'default');
  context.runtime.setMemory(user._id, '{}');

  // upstream: the requested coordinates (0 counts as unset), re-drawn in 3..48 while on a wall
  let x = options.x || Math.floor(3 + random.next() * 46);
  let y = options.y || Math.floor(3 + random.next() * 46);
  for (let tries = 0; isWallAt(terrain, x, y); tries++) {
    if (tries > 100000) {
      throw new Error(`No free spawn position in ${roomName}`);
    }
    x = Math.floor(3 + random.next() * 46);
    y = Math.floor(3 + random.next() * 46);
  }
  insertObject(world, {
    type: 'spawn',
    room: roomName,
    x,
    y,
    name: 'Spawn1',
    user: user._id,
    store: { energy: C.SPAWN_ENERGY_START },
    storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
    hits: C.SPAWN_HITS,
    hitsMax: C.SPAWN_HITS,
    spawning: null,
    notifyWhenAttacked: false,
  });
  controller.user = user._id;
  controller.level = 1;
  controller.progress = 0;
  controller.downgradeTime = null;
  controller.safeMode = world.gameTime + 20000;
  recordRoomObjectWrite(world, controller._id);
  const room = world.rooms[roomName];
  if (room) {
    room.invaderGoal = 1000000;
  }
  activateRoom(world, roomName);
  return { userId: user._id, username };
}

/**
 * Upstream `utils.reloadBotUsers`: every player of a bot AI gets a fresh `t<timestamp>` branch
 * with `modules` (active in world and simulation) replacing its other branches. Returns the
 * reloaded usernames.
 */
export function reloadBot(context: GameContext, botAiName: string, modules: CodeModules): string[] {
  const users = Object.values(context.state.world.users).filter((user) => user.bot === botAiName);
  const timestamp = context.now();
  const branch = `t${String(timestamp)}`;
  for (const user of users) {
    replaceBranches(context, user._id, modules, branch, timestamp);
  }
  return users.map((user) => user.username ?? user._id);
}

/**
 * Upstream `bots.removeUser`: respawn a bot player (exact username match), then delete its user
 * document, code branches and runtime data (memory). Like upstream, its notifications, market
 * orders and history are kept. Returns the removed user id so hosts can drop their account records.
 */
export function removeBot(context: GameContext, username: string): string {
  const { state } = context;
  const user = Object.values(state.world.users).find(
    (candidate) => candidate.username === username,
  );
  if (!user) {
    throw new Error('User not found');
  }
  if (!user.bot) {
    throw new Error('User is not a bot');
  }
  respawnUser(state, user._id);
  Reflect.deleteProperty(state.world.users, user._id);
  for (const [id, branch] of Object.entries(state.branches)) {
    if (branch.user === user._id) {
      Reflect.deleteProperty(state.branches, id);
    }
  }
  context.runtime.removeUser(user._id);
  return user._id;
}

/**
 * Upstream `utils.respawnUser`: remove the player's creeps, power creeps and construction sites,
 * turn its structures into ruins of the system user, hand its older ruins to the system user (their
 * `structure.user` is kept, as upstream), release its controllers and flags. Nothing is scheduled.
 *
 * Deliberate difference: upstream also reopens EVERY room (`rooms.update({_id: undefined})` from an
 * un-awaited query, sent as `{}` by the storage RPC); here only the player's controller rooms are
 * set back to `normal`, so closed rooms and other players' rooms are not touched.
 */
export function respawnUser(state: GameState, userId: string): void {
  const world = state.world;
  const systemUserId = ensureSystemUser(world);
  const gameTime = world.gameTime;
  const structureTypes = new Set<string>(Object.keys(C.CONSTRUCTION_COST));

  for (const [id, creep] of Object.entries(world.userPowerCreeps)) {
    if (creep.user === userId) {
      Reflect.deleteProperty(world.userPowerCreeps, id);
    }
  }
  const owned = Object.values(world.roomObjects).filter((o) => o.user === userId);
  // ruins of the player's structures, inserted in the order the storage returns the structures
  const structureIds = storageIndexOrder(
    world,
    owned.filter((o) => structureTypes.has(o.type)),
  );
  for (const object of structureIds.map((id) => world.roomObjects[id] as RoomObject)) {
    insertObject(world, {
      type: 'ruin',
      user: systemUserId,
      room: object.room,
      x: object.x,
      y: object.y,
      structure: {
        id: object._id,
        type: object.type,
        hits: 0,
        hitsMax: object.hitsMax,
        user: systemUserId,
      },
      store: object.store ?? {},
      destroyTime: gameTime,
      decayTime: gameTime + 500000,
    });
  }
  const oldRuins = owned.filter((o) => o.type === 'ruin');
  const oldRuinIds = storageIndexOrder(world, oldRuins);
  for (const ruin of oldRuins) {
    ruin.user = systemUserId;
  }
  recordRoomObjectWrites(world, oldRuinIds);
  for (const object of owned) {
    if (object.type !== 'controller' && object.type !== 'ruin') {
      Reflect.deleteProperty(world.roomObjects, object._id);
    }
  }
  for (const [id, flag] of Object.entries(world.flags)) {
    if (flag.user === userId) {
      Reflect.deleteProperty(world.flags, id);
    }
  }
  const controllers = owned.filter((o) => o.type === 'controller');
  const controllerIds = storageIndexOrder(world, controllers);
  for (const controller of controllers) {
    const room = world.rooms[controller.room];
    if (room) {
      room.status = 'normal';
    }
    Object.assign(controller, {
      level: 0,
      hits: 0,
      hitsMax: 0,
      progress: 0,
      progressTotal: 0,
      user: null,
      downgradeTime: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      isPowerEnabled: false,
    });
  }
  recordRoomObjectWrites(world, controllerIds);
  const user = world.users[userId];
  if (user) {
    user.rooms = [];
  }
}

/** Upstream `utils.getUserWorldStatus`. */
export function getUserWorldStatus(world: WorldState, userId: string): 'empty' | 'normal' | 'lost' {
  const objects = Object.values(world.roomObjects).filter((o) => o.user === userId);
  if (!objects.length) {
    return 'empty';
  }
  const spawns = objects.some(
    (spawn) =>
      spawn.type === 'spawn' &&
      objects.some(
        (o) => o.type === 'controller' && o.room === spawn.room && o.user === spawn.user,
      ),
  );
  return spawns ? 'normal' : 'lost';
}
