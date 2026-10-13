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

import { isRecord } from '../../src/guards.ts';
import type { CodeBranch, GameState, NotificationRecipient, WorldState } from '../../src/index.ts';
import type * as GameExports from '../../src/index.ts';
import type { WorldRandom } from '../../src/world/random.ts';
import type { Document, Dump, Game, Local, TranslateModules, View } from './types.ts';

interface StoredDocument extends Document {
  _id: string;
}
interface StoredBranch extends Omit<CodeBranch, 'timestamp'> {
  timestamp?: number | string;
}
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
] as const;

const DATE_FIELDS: Record<string, string> = { 'users.money': 'date', 'users.resources': 'date' };

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
} as const;

export async function loadLocal(gameRoot: string) {
  // --local-root selects current or extracted historical source at runtime.
  const url = (path: string) => pathToFileURL(join(gameRoot, path)).href;
  const game = (await import(url('src/index.ts'))) as typeof GameExports;
  const random = (await import(url('src/world/random.ts'))) as { WorldRandom: typeof WorldRandom };
  return { game, WorldRandom: random.WorldRandom };
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Build a local game (state + live runtime + host profiles) from a storage dump. */
export function toLocal(
  game: Game,
  dump: Dump,
  now: () => number,
  translateModules: TranslateModules = (modules) => modules,
): Local {
  const envData = dump.env[0]?.data ?? {};
  const jobs: GameState['jobs'] = {};
  const profiles: Local['profiles'] = {};
  const world = game.createWorldState({
    gameTime: Number.parseInt(String(envData.gameTime), 10),
    activeRooms: clone(envData.activeRooms ?? []),
  });
  for (const [collection, field] of Object.entries(WORLD_COLLECTIONS)) {
    for (const source of dump.collections[collection] ?? []) {
      // The pinned storage schema provides ids and collection-specific document fields.
      const doc = clone(source) as StoredDocument;
      for (const [owner, name, prefix] of JOB_FIELDS) {
        if (owner === collection && doc[name] !== undefined) {
          jobs[prefix + doc._id] = doc[name] as number;
          Reflect.deleteProperty(doc, name);
        }
      }
      if (collection === 'users') {
        const profile: Document = {};
        for (const name of HOST_USER_FIELDS) {
          if (doc[name] !== undefined) profile[name] = doc[name];
          Reflect.deleteProperty(doc, name);
        }
        profiles[doc._id] = profile;
      }
      const dateField = DATE_FIELDS[collection];
      const date = dateField === undefined ? undefined : doc[dateField];
      if (dateField && typeof date === 'string') doc[dateField] = Date.parse(date);
      const records: Record<string, object> = world[field];
      records[doc._id] = doc;
    }
  }
  for (const doc of dump.collections['rooms.terrain'] ?? []) {
    world.terrain[doc.room as string] = doc.terrain as string;
  }

  const runtime = new game.BotRuntime({ now: () => now() });
  const branches: GameState['branches'] = {};
  for (const doc of dump.collections['users.code'] ?? []) {
    const branch = clone(doc) as unknown as StoredBranch;
    branch.modules = translateModules(branch.modules);
    // `new Date()` timestamps reach the storage as ISO strings through the RPC
    if (typeof branch.timestamp === 'string') branch.timestamp = Date.parse(branch.timestamp);
    branches[branch._id] = branch as CodeBranch;
    if (branch.activeWorld) runtime.setCode(branch.user, clone(branch.modules), branch.branch);
  }
  for (const [key, value] of Object.entries(envData)) {
    if (key.startsWith('memory:') && typeof value === 'string') {
      runtime.setMemory(key.slice('memory:'.length), value);
    }
    if (key.startsWith('mapView:') && typeof value === 'string') {
      world.mapViews[key.slice('mapView:'.length)] = JSON.parse(
        value,
      ) as WorldState['mapViews'][string];
    }
  }
  const pendingIntents: Record<
    string,
    Record<string, GameState['pendingIntents'][string][string]>
  > = {};
  for (const doc of dump.collections['rooms.intents'] ?? []) {
    const users = (doc.users ?? {}) as Record<
      string,
      { objectsManual?: GameState['pendingIntents'][string][string] }
    >;
    for (const [user, intents] of Object.entries(users)) {
      if (intents.objectsManual) {
        (pendingIntents[doc.room as string] ??= {})[user] = clone(intents.objectsManual);
      }
    }
  }
  const pendingGlobalIntents: GameState['pendingGlobalIntents'] = {};
  for (const doc of dump.collections['users.intents'] ?? []) {
    const target = (pendingGlobalIntents[doc.user as string] ??= {});
    for (const [name, list] of Object.entries((doc.intents ?? {}) as Record<string, unknown[]>)) {
      // Global intent names and payloads are the upstream sanitizer's storage output.
      const lists = target as Record<string, unknown[]>;
      (lists[name] ??= []).push(...clone(list));
    }
  }
  const state: GameState = {
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
      notificationRecipient(userId: string) {
        const profile = profiles[userId];
        if (!profile) return undefined;
        const recipient: NotificationRecipient = {};
        if (typeof profile.email === 'string') recipient.email = profile.email;
        if (isRecord(profile.notifyPrefs)) recipient.preferences = profile.notifyPrefs;
        return recipient;
      },
    },
  };
}

/** Project a local game back into the storage layout for comparison. */
export function fromLocal(local: Local): View {
  const { state, runtime, profiles } = local;
  const { world } = state;
  const collections: Record<string, Document[]> = {};
  for (const [collection, field] of Object.entries(WORLD_COLLECTIONS)) {
    const records: Record<string, object> = world[field];
    collections[collection] = Object.values(records).map((source) => {
      const doc = clone(source) as StoredDocument;
      for (const [owner, name, prefix] of JOB_FIELDS) {
        if (owner === collection && state.jobs[prefix + doc._id] !== undefined) {
          doc[name] = state.jobs[prefix + doc._id];
        }
      }
      if (collection === 'users') Object.assign(doc, clone(profiles[doc._id] ?? {}));
      const dateField = DATE_FIELDS[collection];
      const date = dateField === undefined ? undefined : doc[dateField];
      if (dateField && typeof date === 'number') {
        doc[dateField] = new Date(date).toISOString();
      }
      return doc;
    });
  }
  collections['rooms.terrain'] = Object.entries(world.terrain).map(([room, terrain]) => ({
    room,
    terrain,
  }));
  collections['users.code'] = Object.values(state.branches).map(
    (branch) => clone(branch) as unknown as Document,
  );
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
  const memory: Record<string, unknown> = {};
  for (const [user, snapshot] of Object.entries(runtime.snapshot().users)) {
    // the runtime keeps '' for "no Memory stored"; upstream simply has no `memory:<user>` key
    if (snapshot.memory !== '') memory[user] = snapshot.memory;
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
