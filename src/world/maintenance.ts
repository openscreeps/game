/*
 * Backend maintenance jobs, ported from screeps/backend `lib/cronjobs.js` and `lib/strongholds.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 *
 * Every job mutates `state` synchronously and is run between ticks while no tick is in flight.
 * `Math.random()` is replaced by the world's seeded generator; `Date.now()` by `now`. Private
 * account data (e-mail, notification preferences) is only reachable through `MaintenanceHooks`.
 */

import {
  constants as C,
  recordRoomObjectWrites,
  worldConstants,
  type Constants,
  type WorldState,
} from '@openscreeps/engine';
import type { GameState } from '../contracts.ts';
import { WorldRandom } from './random.ts';
import {
  activateRoom,
  insertObject,
  isCenter,
  isWallAt,
  nextId,
  roomNameFromXY,
  roomNameToXY,
  roomObjectsOf,
  storageIndexOrder,
} from './rooms.ts';
import { expandStrongholds, genStrongholds } from './strongholds.ts';

export type MaintenanceJobName =
  | 'sendNotifications'
  | 'roomsForceUpdate'
  | 'genPowerBanks'
  | 'genInvaders'
  | 'purgeTransactions'
  | 'recreateNpcOrders'
  | 'calcMarketStats'
  | 'deletePowerCreeps'
  | 'genDeposits'
  | 'genStrongholds'
  | 'expandStrongholds';

export interface MaintenanceJob {
  /** Minimal wall-clock interval between runs, in seconds (upstream `config.cronjobs`). */
  interval: number;
  run(state: GameState, now: number, run: MaintenanceRun): void;
}

/** Where and how often a player wants notification mail; hosts own this account data. */
export interface NotificationRecipient {
  email?: string;
  /** Backend `users.notifyPrefs`: `disabled` drops notifications, `interval` is in minutes. */
  preferences?: Readonly<Record<string, unknown>>;
}

export interface MaintenanceHooks {
  /** Account data of a player; `undefined` means none (hourly batches without an address). */
  notificationRecipient?(userId: string): NotificationRecipient | undefined;
}

/**
 * One due notification as upstream hands it to `sendUserNotifications` (`_.pick(doc, ['message',
 * 'date', 'count', 'type'])`).
 */
export interface NotificationDetail {
  message: string;
  date: number;
  count: number;
  type: string;
}

/** One player's due notifications, ready for delivery by the host. */
export interface NotificationBatch {
  id: string;
  userId: string;
  email?: string;
  /** Each notification formatted as `message\n[type] (count)`, as the upstream mailer mod does. */
  messages: string[];
  /** The source notifications, in the same order as `messages`. */
  notifications: NotificationDetail[];
  date: number;
}

/** Hooks and outputs shared by the jobs of one maintenance pass. */
export interface MaintenanceRun {
  hooks: MaintenanceHooks;
  notifications: NotificationBatch[];
}

export interface MaintenanceReport {
  /** Jobs that ran, in registry order (hosts scheduling their own table may report other names). */
  ran: string[];
  /** Jobs that threw; the rest still ran (upstream logs and continues). */
  errors: Array<{ job: string; error: unknown }>;
  /** Notification batches produced by `sendNotifications`, in creation order. */
  notifications: NotificationBatch[];
}

/** `state.jobs` key holding the last run timestamp of a job. */
export const jobKey = (name: string): string => `cron:${name}`;
const FORCE_UPDATE_KEY = 'forceUpdate:';
const NPC_ORDERS_KEY = 'npcOrders:';
const NOTIFY_KEY = 'notify:';

// ---------------------------------------------------------------------------------------------
// sendNotifications

function sendNotifications(state: GameState, now: number, run: MaintenanceRun): void {
  const world = state.world;
  const byUser = new Map<string, string[]>();
  for (const notification of Object.values(world.notifications)) {
    if (notification.date < now) {
      let list = byUser.get(notification.user);
      if (!list) {
        list = [];
        byUser.set(notification.user, list);
      }
      list.push(notification._id);
    }
  }
  // upstream loads the users of due notifications (`users.find({_id: {$in}})`, storage order);
  // notifications of users that no longer exist stay untouched
  for (const { _id: userId } of Object.values(world.users)) {
    const ids = byUser.get(userId);
    if (!ids) {
      continue;
    }
    const remove = (): void => {
      for (const id of ids) {
        Reflect.deleteProperty(world.notifications, id);
      }
    };
    const recipient = run.hooks.notificationRecipient?.(userId);
    const prefs = recipient?.preferences;
    const email = recipient?.email;
    if (prefs && (prefs['disabled'] || !email)) {
      remove();
      state.jobs[NOTIFY_KEY + userId] = now;
      continue;
    }
    const intervalMinutes = prefs?.['interval'];
    const interval =
      (typeof intervalMinutes === 'number' && intervalMinutes ? intervalMinutes : 60) * 60 * 1000;
    const lastNotifyDate = state.jobs[NOTIFY_KEY + userId];
    if (lastNotifyDate && lastNotifyDate + interval > now) {
      continue;
    }
    const notifications: NotificationDetail[] = [];
    for (const id of ids) {
      const n = world.notifications[id];
      if (n) {
        notifications.push({ message: n.message, date: n.date, count: n.count, type: n.type });
      }
    }
    const entry: NotificationBatch = {
      id: nextId(world, {}),
      userId,
      messages: notifications.map((n) => `${n.message}\n[${n.type}] (${String(n.count)})`),
      notifications,
      date: now,
    };
    if (email) {
      entry.email = email;
    }
    run.notifications.push(entry);
    remove();
    state.jobs[NOTIFY_KEY + userId] = now;
  }
}

// ---------------------------------------------------------------------------------------------
// roomsForceUpdate

function roomsForceUpdate(state: GameState): void {
  const world = state.world;
  const random = new WorldRandom(world);
  const gameTime = world.gameTime;
  const active = new Set(world.activeRooms);
  for (const room of Object.values(world.rooms)) {
    if (room.status === 'out of borders' || active.has(room._id)) {
      continue;
    }
    const next = state.jobs[FORCE_UPDATE_KEY + room._id];
    if (!next || gameTime >= next) {
      activateRoom(world, room._id);
      state.jobs[FORCE_UPDATE_KEY + room._id] = gameTime + 90 + random.index(20);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// genPowerBanks / genDeposits

/**
 * One draw of the upstream power bank/deposit spot search: a random tile in 5..44 and whether it is
 * a wall with an open tile in its 3x3 square.
 */
function drawWallSpot(random: WorldRandom, terrain: string): { x: number; y: number; ok: boolean } {
  const x = random.index(40) + 5;
  const y = random.index(40) + 5;
  let hasExit = false;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!isWallAt(terrain, x + dx, y + dy)) {
        hasExit = true;
      }
    }
  }
  return { x, y, ok: isWallAt(terrain, x, y) && hasExit };
}

function genPowerBanks(state: GameState): void {
  const world = state.world;
  const C = worldConstants(world);
  const random = new WorldRandom(world);
  const gameTime = world.gameTime;
  for (const room of Object.values(world.rooms)) {
    if (!room.bus || room.status !== 'normal') {
      continue;
    }
    const respawnTime = Math.round(
      (random.next() * C.POWER_BANK_RESPAWN_TIME) / 2 + C.POWER_BANK_RESPAWN_TIME * 0.75,
    );
    if (!room.powerBankTime) {
      room.powerBankTime = gameTime + respawnTime;
      continue;
    }
    if (gameTime < room.powerBankTime) {
      continue;
    }
    room.powerBankTime = gameTime + respawnTime;
    const terrain = world.terrain[room._id];
    if (terrain === undefined) {
      continue;
    }
    // upstream draws until it finds a spot (other objects are not checked) and never gives up; the
    // cap only guards against a room without any wall next to an open tile
    let spot: { x: number; y: number; ok: boolean } | undefined;
    for (let tries = 0; tries < 100000 && !spot?.ok; tries++) {
      spot = drawWallSpot(random, terrain);
    }
    if (!spot?.ok) {
      continue;
    }
    let power = Math.floor(
      random.next() * (C.POWER_BANK_CAPACITY_MAX - C.POWER_BANK_CAPACITY_MIN) +
        C.POWER_BANK_CAPACITY_MIN,
    );
    if (random.next() < C.POWER_BANK_CAPACITY_CRIT) {
      power += C.POWER_BANK_CAPACITY_MAX;
    }
    insertObject(world, {
      type: 'powerBank',
      x: spot.x,
      y: spot.y,
      room: room._id,
      store: { power },
      hits: C.POWER_BANK_HITS,
      hitsMax: C.POWER_BANK_HITS,
      decayTime: gameTime + C.POWER_BANK_DECAY,
    });
    activateRoom(world, room._id);
  }
}

/** Highway rooms bordering the sector of a center room `xx5yy5` (upstream `getSectorEdges`). */
function getSectorEdges(centralRoomName: string): string[] | undefined {
  const result = /^([WE])(\d*)5([NS])(\d*)5$/.exec(centralRoomName);
  if (!result) {
    return undefined;
  }
  const [, we, xs, ns, ys] = result as unknown as [string, string, string, string, string];
  const xx = 10 * Number(xs);
  const yy = 10 * Number(ys);
  const roomNames = new Set<string>();
  for (let i = 0; i <= 10; i++) {
    roomNames.add(`${we}${String(xx + i)}${ns}${String(yy)}`);
    roomNames.add(`${we}${String(xx + 10)}${ns}${String(yy + i)}`);
    roomNames.add(`${we}${String(xx)}${ns}${String(yy + i)}`);
    roomNames.add(`${we}${String(xx + i)}${ns}${String(yy + 10)}`);
  }
  return [...roomNames];
}

/**
 * Upstream `genDeposits`, quirks included: the center filter is the string `'^[WE]\d*5[NS]\d*5$'`,
 * in which `\d` collapses to a literal `d`, so only single-digit centers such as `W5N5` qualify;
 * candidate rooms come in storage order; the spot search ignores its own `inSector` result and
 * gives up on the 1000th draw; a center without free rooms or terrain ends the whole job.
 */
function genDeposits(state: GameState): void {
  const world = state.world;
  const C = worldConstants(world);
  const random = new WorldRandom(world);
  const gameTime = world.gameTime;
  const centralRooms = Object.values(world.rooms).filter(
    (room) => /^[WE]d*5[NS]d*5$/.test(room._id) && room.status !== 'out of borders',
  );
  // fetched once: deposits created by this run do not count for later centers
  const deposits = Object.values(world.roomObjects).filter((o) => o.type === 'deposit');

  for (const center of centralRooms) {
    const sectorEdges = getSectorEdges(center._id) as string[];
    const [cx, cy] = roomNameToXY(center._id);
    const cxx = 24 + 50 * cx;
    const cyy = 24 + 50 * cy;
    // half of the sector size (250 tiles) around the center of the central room
    const sectorDeposits = deposits.filter((d) => {
      if (!sectorEdges.includes(d.room)) return false;
      const [xx, yy] = roomNameToXY(d.room);
      return Math.abs(50 * xx + d.x - cxx) < 250 && Math.abs(50 * yy + d.y - cyy) < 250;
    });
    const throughput = sectorDeposits.reduce(
      (sum, deposit) =>
        sum +
        20 /
          Math.max(
            1,
            C.DEPOSIT_EXHAUST_MULTIPLY * Math.pow(deposit.harvested ?? 0, C.DEPOSIT_EXHAUST_POW),
          ),
      0,
    );
    if (throughput >= 2.5) {
      continue;
    }
    const rooms = Object.values(world.rooms).filter(
      (room) =>
        sectorEdges.includes(room._id) &&
        room.bus === true &&
        room.status === 'normal' &&
        room.depositType !== undefined,
    );
    if (!rooms.length) {
      throw new Error(`No normal bus rooms found for the sector of ${center._id}`);
    }
    const busyRooms = sectorDeposits.map((d) => d.room);
    const room = random.sample(rooms.filter((r) => !busyRooms.includes(r._id)));
    if (!room) {
      return;
    }
    const terrain = world.terrain[room._id];
    if (terrain === undefined) {
      return;
    }
    const objects = roomObjectsOf(world, room._id);
    let spot: { x: number; y: number; ok: boolean };
    let cnt = 0;
    do {
      cnt++;
      spot = drawWallSpot(random, terrain);
      const { x, y } = spot;
      if (objects.some((o) => Math.abs(o.x - x) <= 2 && Math.abs(o.y - y) <= 2)) {
        spot.ok = false;
      }
    } while (!spot.ok && cnt < 1000);
    if (cnt >= 1000) {
      continue;
    }
    if (room.depositType) {
      insertObject(world, {
        type: 'deposit',
        depositType: room.depositType,
        x: spot.x,
        y: spot.y,
        room: room._id,
        harvested: 0,
        decayTime: C.DEPOSIT_DECAY_TIME + gameTime,
      });
      activateRoom(world, room._id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// genInvaders

export const INVADER_BODIES: Readonly<Record<string, readonly string[]>> = {
  bigHealer: [...Array<string>(24).fill('move'), ...Array<string>(25).fill('heal'), 'move'],
  bigRanged: [
    ...Array<string>(6).fill('tough'),
    ...Array<string>(24).fill('move'),
    ...Array<string>(18).fill('ranged_attack'),
    'work',
    'move',
  ],
  bigMelee: [
    ...Array<string>(16).fill('tough'),
    ...Array<string>(24).fill('move'),
    ...Array<string>(3).fill('ranged_attack'),
    ...Array<string>(4).fill('work'),
    'attack',
    'attack',
    'move',
  ],
  smallHealer: ['move', 'move', 'move', 'move', 'heal', 'heal', 'heal', 'heal', 'heal', 'move'],
  smallRanged: [
    'tough',
    'tough',
    'move',
    'move',
    'move',
    'move',
    'ranged_attack',
    'ranged_attack',
    'ranged_attack',
    'move',
  ],
  smallMelee: [
    'tough',
    'tough',
    'move',
    'move',
    'move',
    'move',
    'ranged_attack',
    'work',
    'attack',
    'move',
  ],
};

const INVADER_BOOSTS: Readonly<Record<string, readonly [string, string]>> = {
  // [center rooms, other rooms]
  heal: ['XLHO2', 'LO'],
  ranged_attack: ['XKHO2', 'KO'],
  work: ['XZH2O', 'ZH'],
  attack: ['XUH2O', 'UH'],
  tough: ['XGHO2', 'GO'],
};

type Square = [number, number];

function createInvader(
  world: WorldState,
  random: WorldRandom,
  type: string,
  room: string,
  square: Square,
  boosted: boolean,
): void {
  const [x, y] = roomNameToXY(room);
  const parts = INVADER_BODIES[type] as readonly string[];
  const center = isCenter(x, y);
  const body = parts.map((part) => {
    const boost = boosted ? INVADER_BOOSTS[part] : undefined;
    return boost
      ? { type: part, hits: 100, boost: boost[center ? 0 : 1] }
      : { type: part, hits: 100 };
  });
  insertObject(world, {
    type: 'creep',
    user: '2',
    body,
    hits: parts.length * 100,
    hitsMax: parts.length * 100,
    ticksToLive: 1500,
    x: square[0],
    y: square[1],
    room,
    fatigue: 0,
    store: {},
    storeCapacity: 0,
    name: `invader_${room}_${String(random.index(1000))}`,
  });
}

function createRaid(
  world: WorldState,
  random: WorldRandom,
  controllerLevel: number | undefined,
  room: string,
  exits: Square[],
): void {
  const type = controllerLevel && controllerLevel >= 4 ? 'big' : 'small';
  const level = controllerLevel ?? 0;
  let max: number;
  let count = 1;
  let boostChance = 0.5;
  const [x, y] = roomNameToXY(room);
  const center = isCenter(x, y);

  if (random.next() > 0.9 || center) {
    max = 2;
    boostChance = type === 'big' ? 0 : 0.5;
    if (random.next() > 0.8 || center) {
      max = 5;
      if (type === 'big') {
        if (level < 7) {
          max = level < 6 ? 2 : 3;
        } else if (level < 8) {
          boostChance = 0.4;
          max = 3;
        } else {
          boostChance = 0.4;
          max = 5;
        }
      }
    }
    count = random.index(max - 1) + 2;
    count = Math.min(count, exits.length);
  }

  let lastSquare: Square | undefined;
  for (let i = 0; i < count; i++) {
    const subtype =
      i === 0 && !center
        ? 'Melee'
        : i === 0 || ((i === 1 || (i === 2 && count === 5)) && random.next() > 0.5)
          ? 'Ranged'
          : 'Healer';
    let square: Square | undefined;
    if (lastSquare) {
      const from = lastSquare;
      // lodash `_.sortBy` is stable: the first of the closest exits wins
      let best = Infinity;
      for (const candidate of exits) {
        const d = Math.max(Math.abs(candidate[0] - from[0]), Math.abs(candidate[1] - from[1]));
        if (d < best) {
          best = d;
          square = candidate;
        }
      }
    } else {
      square = exits[random.index(exits.length)];
    }
    if (!square) {
      break;
    }
    createInvader(world, random, type + subtype, room, square, random.next() < boostChance);
    exits.splice(exits.indexOf(square), 1);
    lastSquare = square;
  }
}

function genInvaders(state: GameState): void {
  const world = state.world;
  const C = worldConstants(world);
  const random = new WorldRandom(world);
  const active = new Set(world.activeRooms);
  const sectorsWithCore = new Set(
    Object.values(world.roomObjects)
      .filter((o) => o.type === 'invaderCore' && (o.level ?? 0) > 0)
      .map((o) => sectorRegexKey(o.room)),
  );

  for (const room of Object.values(world.rooms)) {
    if (room.status !== 'normal' || active.has(room._id)) {
      continue;
    }
    const objects = roomObjectsOf(world, room._id);
    if (objects.some((o) => o.type === 'creep' && o.user === '2')) {
      continue;
    }
    const sources = objects.filter((o) => o.type === 'source');
    const invaderHarvested = sources.reduce((sum, s) => sum + (s.invaderHarvested ?? 0), 0);
    const goal = room.invaderGoal || C.INVADERS_ENERGY_GOAL;
    if (goal !== 1 && invaderHarvested < goal) {
      continue;
    }
    if (!sectorsWithCore.has(sectorRegexKey(room._id))) {
      continue;
    }
    const terrain = world.terrain[room._id];
    if (terrain === undefined) {
      continue;
    }

    const exitSquares: Record<'top' | 'left' | 'right' | 'bottom', Square[]> = {
      top: [],
      left: [],
      right: [],
      bottom: [],
    };
    const exitOrder: Array<'top' | 'left' | 'right' | 'bottom'> = [];
    const addExit = (side: 'top' | 'left' | 'right' | 'bottom', square: Square): void => {
      if (!exitOrder.includes(side)) {
        exitOrder.push(side);
      }
      exitSquares[side].push(square);
    };
    for (let i = 0; i < 49; i++) {
      if (!isWallAt(terrain, i, 0)) addExit('top', [i, 0]);
      if (!isWallAt(terrain, i, 49)) addExit('bottom', [i, 49]);
      if (!isWallAt(terrain, 0, i)) addExit('left', [0, i]);
      if (!isWallAt(terrain, 49, i)) addExit('right', [49, i]);
    }
    const [rx, ry] = roomNameToXY(room._id);
    const exits = exitOrder.filter((exit) => {
      const nx = rx + (exit === 'right' ? 1 : exit === 'left' ? -1 : 0);
      const ny = ry + (exit === 'bottom' ? 1 : exit === 'top' ? -1 : 0);
      const neighbor = roomNameFromXY(nx, ny);
      const controller = Object.values(world.roomObjects).find(
        (o) => o.room === neighbor && o.type === 'controller',
      );
      return !(controller && (controller.user || controller.reservation));
    });
    if (!exits.length) {
      continue;
    }
    const exit = exits[random.index(exits.length)] as 'top' | 'left' | 'right' | 'bottom';
    const controller = objects.find((o) => o.type === 'controller');
    createRaid(
      world,
      random,
      controller?.user ? controller.level : undefined,
      room._id,
      exitSquares[exit],
    );

    let invaderGoal = Math.floor(C.INVADERS_ENERGY_GOAL * (random.next() * 0.6 + 0.7));
    if (random.next() < 0.1) {
      invaderGoal *= Math.floor(random.next() > 0.5 ? 2 : 0.5);
    }
    room.invaderGoal = invaderGoal;
    // upstream `update({room, type: 'source'})`: one write per source in storage find order
    const sourceIds = storageIndexOrder(world, sources);
    for (const source of sources) {
      source.invaderHarvested = 0;
    }
    recordRoomObjectWrites(world, sourceIds);
    activateRoom(world, room._id);
  }
}

/** Upstream sector regex `^W\dN\d$` built from the leading digits of a room name. */
function sectorRegexKey(roomName: string): string {
  return roomName.replace(/^([WE]\d*)\d([NS]\d*)\d$/, '$1*$2*');
}

// ---------------------------------------------------------------------------------------------
// purgeTransactions

function purgeTransactions(state: GameState): void {
  const world = state.world;
  const data = Object.values(world.transactions).sort((a, b) => b.time - a.time);
  const senders = new Map<string, number>();
  const recipients = new Map<string, number>();
  for (const transaction of data) {
    const sender = String(transaction.sender);
    const recipient = String(transaction.recipient);
    const sent = senders.get(sender) ?? 0;
    const received = recipients.get(recipient) ?? 0;
    let keep = false;
    if (sent < 100) {
      senders.set(sender, sent + 1);
      keep = true;
    }
    if (received < 100) {
      recipients.set(recipient, received + 1);
      keep = true;
    }
    if (!keep) {
      Reflect.deleteProperty(world.transactions, transaction._id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// recreateNpcOrders

const NPC_MINERALS = [
  'X',
  'Z',
  'K',
  'L',
  'U',
  'O',
  'O',
  'H',
  'H',
  'Z',
  'K',
  'L',
  'U',
  'O',
  'O',
  'H',
  'H',
];
const NPC_SELL_PRICE: Readonly<Record<string, number>> = {
  H: 3000,
  O: 3000,
  Z: 6000,
  K: 6000,
  U: 6000,
  L: 6000,
  X: 18000,
};
const NPC_BUY_PRICE = 1000;
const NPC_PERIOD = 5000;

function recreateNpcOrders(state: GameState, now: number): void {
  const world = state.world;
  const random = new WorldRandom(world);
  const gameTime = world.gameTime;
  // upstream queries `{user: {$eq: null}}`, which the storage evaluates as `$or` of `null` and
  // `undefined` owners and concatenates: terminals with an explicit `null` owner come first
  const all = Object.values(world.roomObjects).filter((o) => o.type === 'terminal');
  const terminals = [
    ...all.filter((o) => o.user === null),
    ...all.filter((o) => o.user === undefined),
  ];
  for (const terminal of terminals) {
    const room = world.rooms[terminal.room];
    if (room?.status !== 'normal') {
      continue;
    }
    const next = state.jobs[NPC_ORDERS_KEY + room._id];
    if (next && next > gameTime) {
      continue;
    }
    const sellMineral = NPC_MINERALS[random.index(NPC_MINERALS.length)] as string;
    const buyMineral = NPC_MINERALS[random.index(NPC_MINERALS.length)] as string;
    const order = (type: string, resourceType: string, amount: number, price: number): void => {
      const id = nextId(world, world.marketOrders);
      world.marketOrders[id] = {
        _id: id,
        created: gameTime,
        createdTimestamp: now,
        active: true,
        type,
        amount,
        remainingAmount: amount,
        totalAmount: amount,
        resourceType,
        price,
        roomName: room._id,
      };
    };
    for (const [id, existing] of Object.entries(world.marketOrders)) {
      if (existing.roomName === room._id) {
        Reflect.deleteProperty(world.marketOrders, id);
      }
    }
    order(C.ORDER_SELL, sellMineral, NPC_PERIOD * 40, NPC_SELL_PRICE[sellMineral] as number);
    if (random.next() < 0.5) {
      order(C.ORDER_SELL, C.RESOURCE_ENERGY, NPC_PERIOD * 40, 1000);
    }
    if (random.next() < 0.25) {
      order(C.ORDER_BUY, buyMineral, NPC_PERIOD * 20, NPC_BUY_PRICE);
    }
    state.jobs[NPC_ORDERS_KEY + room._id] =
      gameTime + Math.round(NPC_PERIOD * (0.8 + 0.4 * random.next()));
  }
}

// ---------------------------------------------------------------------------------------------
// calcMarketStats

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${String(date.getFullYear())}-${month < 10 ? '0' : ''}${String(month)}-${day < 10 ? '0' : ''}${String(day)}`;
}

function calcMarketStats(state: GameState, now: number): void {
  const world = state.world;
  world.marketStats = {};
  const since = now - 14 * 24 * 3600 * 1000;
  const sales = Object.values(world.usersMoney).filter(
    (i) => i.date > since && i.type === 'market.sell' && i.market.resourceType !== undefined,
  );
  const result = new Map<
    string,
    Map<string, { sumPrice: number; sumAmount: number; stddev: number; cnt: number; avg: number }>
  >();
  const day = (resourceType: string, date: string) => {
    let byDate = result.get(resourceType);
    if (!byDate) {
      byDate = new Map();
      result.set(resourceType, byDate);
    }
    let entry = byDate.get(date);
    if (!entry) {
      entry = { sumPrice: 0, sumAmount: 0, stddev: 0, cnt: 0, avg: 0 };
      byDate.set(date, entry);
    }
    return entry;
  };
  for (const sale of sales) {
    const entry = day(sale.market.resourceType as string, localDate(sale.date));
    entry.sumPrice += sale.change;
    entry.sumAmount += sale.market.amount ?? 0;
    entry.cnt++;
  }
  for (const byDate of result.values()) {
    for (const entry of byDate.values()) {
      entry.avg = entry.sumPrice / entry.sumAmount;
    }
  }
  for (const sale of sales) {
    const entry = day(sale.market.resourceType as string, localDate(sale.date));
    entry.stddev +=
      ((sale.market.amount ?? 0) * Math.pow((sale.market.price ?? 0) - entry.avg, 2)) /
      entry.sumAmount;
  }
  for (const [resourceType, byDate] of result) {
    for (const [date, entry] of byDate) {
      const id = nextId(world, world.marketStats);
      world.marketStats[id] = {
        _id: id,
        resourceType,
        date,
        transactions: entry.cnt,
        volume: entry.sumAmount,
        avgPrice: +entry.avg.toFixed(3),
        stddevPrice: +Math.sqrt(entry.stddev).toFixed(3),
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// deletePowerCreeps

function calcPowerLevelBase(C: Constants, level: number): number {
  return Math.pow(level, C.POWER_LEVEL_POW) * C.POWER_LEVEL_MULTIPLY;
}

function deletePowerCreeps(state: GameState, now: number): void {
  const world = state.world;
  const C = worldConstants(world);
  for (const creep of Object.values(world.userPowerCreeps)) {
    if (!creep.deleteTime || creep.deleteTime >= now) {
      continue;
    }
    const user = world.users[creep.user];
    if (user) {
      // refund the experience of one power level, interpolated within the current level
      const power = user.power ?? 0;
      const level = Math.floor(Math.pow(power / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW));
      const basePrev = calcPowerLevelBase(C, level - 1);
      const baseCurrent = calcPowerLevelBase(C, level);
      const baseNext = calcPowerLevelBase(C, level + 1);
      const change = Math.round(
        power -
          basePrev -
          ((power - baseCurrent) * (baseCurrent - basePrev)) / (baseNext - baseCurrent),
      );
      user.power = power - change;
    }
    Reflect.deleteProperty(world.userPowerCreeps, creep._id);
  }
}

// ---------------------------------------------------------------------------------------------
// registry

/** Upstream `config.cronjobs`, in registry order. */
export const MAINTENANCE_JOBS: Readonly<Record<MaintenanceJobName, MaintenanceJob>> = {
  sendNotifications: { interval: 60, run: sendNotifications },
  roomsForceUpdate: { interval: 20, run: roomsForceUpdate },
  genPowerBanks: { interval: 5 * 60, run: genPowerBanks },
  genInvaders: { interval: 5 * 60, run: genInvaders },
  purgeTransactions: { interval: 60 * 60, run: purgeTransactions },
  recreateNpcOrders: { interval: 5 * 60, run: recreateNpcOrders },
  calcMarketStats: { interval: 60 * 60, run: calcMarketStats },
  deletePowerCreeps: { interval: 10 * 60, run: deletePowerCreeps },
  genDeposits: { interval: 5 * 60, run: genDeposits },
  genStrongholds: {
    interval: 5 * 60,
    run: (state) => {
      genStrongholds(state.world);
    },
  },
  expandStrongholds: {
    interval: 15 * 60,
    run: (state, now) => {
      expandStrongholds(state.world, now);
    },
  },
};

export function isMaintenanceJobName(name: string): name is MaintenanceJobName {
  return Object.hasOwn(MAINTENANCE_JOBS, name);
}

/**
 * Upstream `system.runCronjob`: run one job immediately without touching its schedule. Returns the
 * notification batches it produced.
 */
export function runJob(
  state: GameState,
  name: string,
  now: number,
  hooks: MaintenanceHooks = {},
): NotificationBatch[] {
  if (!isMaintenanceJobName(name)) {
    throw new Error(`Cronjob "${name}" not found`);
  }
  const run: MaintenanceRun = { hooks, notifications: [] };
  MAINTENANCE_JOBS[name].run(state, now, run);
  return run.notifications;
}

/**
 * Drop per-room/per-user scheduler entries whose room or user no longer exists. `runMaintenance`
 * calls it after any job ran; hosts running jobs on their own schedule call it the same way.
 */
export function pruneJobs(state: GameState): void {
  for (const key of Object.keys(state.jobs)) {
    const room = key.startsWith(FORCE_UPDATE_KEY)
      ? key.slice(FORCE_UPDATE_KEY.length)
      : key.startsWith(NPC_ORDERS_KEY)
        ? key.slice(NPC_ORDERS_KEY.length)
        : undefined;
    if (room !== undefined && !state.world.rooms[room]) {
      Reflect.deleteProperty(state.jobs, key);
    }
    if (key.startsWith(NOTIFY_KEY) && !state.world.users[key.slice(NOTIFY_KEY.length)]) {
      Reflect.deleteProperty(state.jobs, key);
    }
  }
}

/**
 * Run every maintenance job whose interval elapsed since its persisted last run (upstream
 * `cronjobs.run`, called once per main loop). Last-run timestamps live in `state.jobs`, so a
 * restart resumes the schedule instead of replaying every job; a timestamp in the future (clock
 * moved backwards) restarts that job's interval from `now`.
 */
export function runMaintenance(
  state: GameState,
  now: number,
  hooks: MaintenanceHooks = {},
): MaintenanceReport {
  const report: MaintenanceReport = { ran: [], errors: [], notifications: [] };
  const run: MaintenanceRun = { hooks, notifications: report.notifications };
  for (const name of Object.keys(MAINTENANCE_JOBS) as MaintenanceJobName[]) {
    const job = MAINTENANCE_JOBS[name];
    const last = state.jobs[jobKey(name)] ?? 0;
    if (last > now) {
      state.jobs[jobKey(name)] = now;
      continue;
    }
    if (now - last <= job.interval * 1000) {
      continue;
    }
    state.jobs[jobKey(name)] = now;
    report.ran.push(name);
    try {
      job.run(state, now, run);
    } catch (error) {
      report.errors.push({ job: name, error });
    }
  }
  if (report.ran.length) {
    pruneJobs(state);
  }
  return report;
}
