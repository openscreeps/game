/*
 * Player registry: world user documents with their default code branch and runtime state. Account
 * credentials (passwords, e-mail, Steam identities, sessions) belong to the host, never the game.
 */

import { constants, type CodeModules } from '@openscreeps/engine';
import {
  GameError,
  newId,
  type Badge,
  type GameContext,
  type GameState,
  type User,
} from './contracts.ts';
import { respawnUser } from './world/bots.ts';

/** Backend `register/set-username` username rule. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,}$/;

export interface CreatePlayerOptions {
  /** Player name; anonymous players (e.g. Steam sign-ups before choosing a name) have none. */
  username?: string;
  /** CPU limit; default 100. */
  cpu?: number;
  /** Raw GCL points; default 0. */
  gcl?: number;
  /** Bot AI name for NPC players. */
  bot?: string;
  active?: number;
  badge?: Badge;
  /** CPU bucket; default 0. */
  cpuAvailable?: number;
  /** Code of the `default` branch (active in world and simulation); default `{main: ''}`. */
  modules?: CodeModules;
}

export function findUserByUsername(state: GameState, username: string): User | undefined {
  const lower = username.toLowerCase();
  return Object.values(state.world.users).find((user) => user.usernameLower === lower);
}

/** Usernames are unique case-insensitively; the system account name can never be claimed. */
export function isUsernameAvailable(state: GameState, username: string): boolean {
  return (
    USERNAME_PATTERN.test(username) &&
    username.toLowerCase() !== constants.SYSTEM_USERNAME.toLowerCase() &&
    findUserByUsername(state, username) === undefined
  );
}

/** Rejects a username new players cannot take: `invalid username` or `username already exists`. */
export function checkNewUsername(state: GameState, username: string): void {
  if (!USERNAME_PATTERN.test(username)) throw new GameError('invalid username');
  if (!isUsernameAvailable(state, username)) throw new GameError('username already exists');
}

/**
 * Creates a player: `users` document, `default` code branch active in world and simulation,
 * runtime code and empty `Memory`. Synchronous; call while no tick is running.
 */
export function createPlayer(context: GameContext, options: CreatePlayerOptions): User {
  const { state } = context;
  const { username } = options;
  if (username !== undefined) checkNewUsername(state, username);
  const now = context.now();
  const id = newId(state);
  const user: User = {
    _id: id,
    cpu: options.cpu ?? 100,
    cpuAvailable: options.cpuAvailable ?? 0,
    gcl: options.gcl ?? 0,
    money: 0,
    rooms: [],
  };
  if (username !== undefined) {
    user.username = username;
    user.usernameLower = username.toLowerCase();
  }
  if (options.bot !== undefined) user.bot = options.bot;
  else user.powerExperimentations = 30;
  if (options.active !== undefined) user.active = options.active;
  if (options.badge !== undefined) user.badge = structuredClone(options.badge);

  const modules = structuredClone(options.modules ?? { main: '' });
  if (modules.main === undefined) modules.main = '';
  const branchId = newId(state);

  state.world.users[id] = user;
  state.branches[branchId] = {
    _id: branchId,
    user: id,
    branch: 'default',
    modules,
    activeWorld: true,
    activeSim: true,
    timestamp: now,
  };
  context.runtime.setCode(id, modules, 'default');
  context.runtime.setMemory(id, '{}');
  return user;
}

function dropWhere<T>(collection: Record<string, T>, predicate: (value: T) => boolean): void {
  for (const [key, value] of Object.entries(collection)) {
    if (predicate(value)) Reflect.deleteProperty(collection, key);
  }
}

/**
 * Deletes a player: its objects become ruins of the system user (`respawnUser`), then its user
 * document, code, power creeps, notifications, market data, scores, statistics, pending intents and
 * runtime data (memory, segments, isolate) are removed. Synchronous; call while no tick is running.
 */
export function removePlayer(context: GameContext, userId: string): void {
  const { state } = context;
  const { world } = state;
  respawnUser(state, userId);
  Reflect.deleteProperty(world.users, userId);
  dropWhere(state.branches, (branch) => branch.user === userId);
  dropWhere(world.userPowerCreeps, (creep) => creep.user === userId);
  dropWhere(world.notifications, (notification) => notification.user === userId);
  dropWhere(world.marketOrders, (order) => order.user === userId);
  dropWhere(world.usersMoney, (entry) => entry.user === userId);
  dropWhere(world.usersResources, (entry) => entry.user === userId);
  for (const scores of Object.values(state.leaderboard)) Reflect.deleteProperty(scores, userId);
  for (const sample of state.statistics) {
    Reflect.deleteProperty(sample.users, userId);
    for (const room of Object.values(sample.rooms)) Reflect.deleteProperty(room, userId);
  }
  Reflect.deleteProperty(state.pendingGlobalIntents, userId);
  state.pendingIntents = Object.fromEntries(
    Object.entries(state.pendingIntents)
      .map(
        ([room, users]) =>
          [
            room,
            Object.fromEntries(Object.entries(users).filter(([id]) => id !== userId)),
          ] as const,
      )
      .filter(([, users]) => Object.keys(users).length > 0),
  );
  context.runtime.removeUser(userId);
}
