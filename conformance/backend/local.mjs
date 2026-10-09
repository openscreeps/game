/*
 * The local implementation under test: `game/src` loaded directly (Node type stripping), never the
 * installed Git dependency of the server. This module only translates between the backend's
 * storage layout (collections + env) and `GameState`; every rule runs in `game/src`.
 *
 * Layout mapping (both directions, documented in the report):
 * - `rooms.nextForceUpdateTime` <-> `state.jobs['forceUpdate:<room>']`
 * - `rooms.nextNpcMarketOrder` <-> `state.jobs['npcOrders:<room>']`
 * - `users.lastNotifyDate` <-> `state.jobs['notify:<user>']`
 * - host-owned account fields of `users` (HOST_USER_FIELDS) live in host profiles, outside the
 *   game, and reach the game only through `MaintenanceHooks.notificationRecipient`
 * - Date values stored by the RPC as ISO strings (`users.money.date`, `users.resources.date`)
 *   are numbers (ms) in the world
 * - `env.gameTime`/`env.activeRooms`/`env['memory:<user>']` <-> `world.gameTime`,
 *   `world.activeRooms`, runtime memory
 * - `rooms.intents` (`users.<id>.objectsManual`) <-> `state.pendingIntents`
 * - `users.intents` documents <-> `state.pendingGlobalIntents` (grouped per user)
 * - `users.code` <-> `state.branches`
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOST_USER_FIELDS = [
  'email',
  'emailDirty',
  'password',
  'salt',
  'notifyPrefs',
  'registeredDate',
  'steam',
  'lastChargeTime',
  'customBadge',
  'lastOnline',
];

const JOB_FIELDS = [
  ['rooms', 'nextForceUpdateTime', 'forceUpdate:'],
  ['rooms', 'nextNpcMarketOrder', 'npcOrders:'],
  ['users', 'lastNotifyDate', 'notify:'],
];

const DATE_FIELDS = { 'users.money': 'date', 'users.resources': 'date' };

const WORLD_COLLECTIONS = {
  rooms: 'rooms',
  'rooms.objects': 'roomObjects',
  'rooms.flags': 'flags',
  users: 'users',
  'users.power_creeps': 'userPowerCreeps',
  'market.orders': 'marketOrders',
  transactions: 'transactions',
  'users.money': 'usersMoney',
  'users.resources': 'usersResources',
  'users.notifications': 'notifications',
  'market.stats': 'marketStats',
};

export async function loadLocal(gameRoot) {
  const url = (path) => pathToFileURL(join(gameRoot, path)).href;
  const game = await import(url('src/index.ts'));
  const { WorldRandom } = await import(url('src/world/random.ts'));
  return { game, WorldRandom };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Build a local game (state + live runtime + host profiles) from a storage dump. */
export function toLocal(game, dump, now, translateModules = (modules) => modules) {
  const envData = dump.env[0]?.data ?? {};
  const jobs = {};
  const profiles = {};
  const world = game.createWorldState({
    gameTime: Number.parseInt(envData.gameTime, 10),
    activeRooms: clone(envData.activeRooms ?? []),
  });
  for (const [collection, field] of Object.entries(WORLD_COLLECTIONS)) {
    for (const source of dump.collections[collection] ?? []) {
      const doc = clone(source);
      for (const [owner, name, prefix] of JOB_FIELDS) {
        if (owner === collection && doc[name] !== undefined) {
          jobs[prefix + doc._id] = doc[name];
          delete doc[name];
        }
      }
      if (collection === 'users') {
        const profile = {};
        for (const name of HOST_USER_FIELDS) {
          if (doc[name] !== undefined) profile[name] = doc[name];
          delete doc[name];
        }
        profiles[doc._id] = profile;
      }
      const dateField = DATE_FIELDS[collection];
      if (dateField && typeof doc[dateField] === 'string')
        doc[dateField] = Date.parse(doc[dateField]);
      world[field][doc._id] = doc;
    }
  }
  for (const doc of dump.collections['rooms.terrain'] ?? []) world.terrain[doc.room] = doc.terrain;

  const runtime = new game.BotRuntime({ now: () => now() });
  const branches = {};
  for (const doc of dump.collections['users.code'] ?? []) {
    const branch = clone(doc);
    branch.modules = translateModules(branch.modules);
    // `new Date()` timestamps reach the storage as ISO strings through the RPC
    if (typeof branch.timestamp === 'string') branch.timestamp = Date.parse(branch.timestamp);
    branches[doc._id] = branch;
    if (doc.activeWorld) runtime.setCode(doc.user, clone(branch.modules), doc.branch);
  }
  for (const [key, value] of Object.entries(envData)) {
    if (key.startsWith('memory:') && typeof value === 'string') {
      runtime.setMemory(key.slice('memory:'.length), value);
    }
    if (key.startsWith('mapView:') && typeof value === 'string') {
      world.mapViews[key.slice('mapView:'.length)] = JSON.parse(value);
    }
  }
  const pendingIntents = {};
  for (const doc of dump.collections['rooms.intents'] ?? []) {
    for (const [user, intents] of Object.entries(doc.users ?? {})) {
      if (intents.objectsManual) {
        (pendingIntents[doc.room] ??= {})[user] = clone(intents.objectsManual);
      }
    }
  }
  const pendingGlobalIntents = {};
  for (const doc of dump.collections['users.intents'] ?? []) {
    const target = (pendingGlobalIntents[doc.user] ??= {});
    for (const [name, list] of Object.entries(doc.intents ?? {})) {
      (target[name] ??= []).push(...clone(list));
    }
  }
  const state = {
    version: 1,
    world,
    runtime: runtime.snapshot(),
    branches,
    history: {},
    statistics: [],
    leaderboard: {},
    jobs,
    pendingIntents,
    pendingGlobalIntents,
  };
  return {
    state,
    runtime,
    profiles,
    context: {
      state,
      runtime,
      now,
      terrainChanged() {},
    },
    hooks: {
      notificationRecipient(userId) {
        const profile = profiles[userId];
        if (!profile) return undefined;
        const recipient = {};
        if (profile.email !== undefined) recipient.email = profile.email;
        if (profile.notifyPrefs !== undefined) recipient.preferences = profile.notifyPrefs;
        return recipient;
      },
    },
  };
}

/** Project a local game back into the storage layout for comparison. */
export function fromLocal(local) {
  const { state, runtime, profiles } = local;
  const { world } = state;
  const collections = {};
  for (const [collection, field] of Object.entries(WORLD_COLLECTIONS)) {
    collections[collection] = Object.values(world[field]).map((source) => {
      const doc = clone(source);
      for (const [owner, name, prefix] of JOB_FIELDS) {
        if (owner === collection && state.jobs[prefix + doc._id] !== undefined) {
          doc[name] = state.jobs[prefix + doc._id];
        }
      }
      if (collection === 'users') Object.assign(doc, clone(profiles[doc._id] ?? {}));
      const dateField = DATE_FIELDS[collection];
      if (dateField && typeof doc[dateField] === 'number') {
        doc[dateField] = new Date(doc[dateField]).toISOString();
      }
      return doc;
    });
  }
  collections['rooms.terrain'] = Object.entries(world.terrain).map(([room, terrain]) => ({
    room,
    terrain,
  }));
  collections['users.code'] = Object.values(state.branches).map(clone);
  collections['rooms.intents'] = Object.entries(state.pendingIntents).map(([room, users]) => ({
    room,
    users: Object.fromEntries(
      Object.entries(users).map(([user, objectsManual]) => [
        user,
        { objectsManual: clone(objectsManual) },
      ]),
    ),
  }));
  collections['users.intents'] = Object.entries(state.pendingGlobalIntents).map(
    ([user, intents]) => ({
      user,
      intents: clone(intents),
    }),
  );
  const memory = {};
  for (const [user, snapshot] of Object.entries(runtime.snapshot().users)) {
    // the runtime keeps '' for "no Memory stored"; upstream simply has no `memory:<user>` key
    if (snapshot.memory !== undefined && snapshot.memory !== '') memory[user] = snapshot.memory;
  }
  return {
    collections,
    env: {
      gameTime: world.gameTime,
      activeRooms: [...world.activeRooms],
      memory,
      mapViews: clone(world.mapViews),
    },
  };
}
