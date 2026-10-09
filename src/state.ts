/*
 * Game state lifecycle: creation of a new world, credential-free projection of a host state and
 * fail-closed validation of untrusted snapshots.
 */

import { BotRuntime } from '@openscreeps/engine';
import type { GameState } from './contracts.ts';
import { isRecord } from './guards.ts';
import { createWorld, type CreateWorldOptions } from './world/generate.ts';

/** Every `GameState` field; the compiler keeps this list exhaustive. */
const GAME_STATE_FIELDS: { readonly [K in keyof GameState]-?: true } = {
  version: true,
  world: true,
  runtime: true,
  branches: true,
  history: true,
  statistics: true,
  leaderboard: true,
  jobs: true,
  pendingIntents: true,
  pendingGlobalIntents: true,
};

/** A new generated world with empty player records. */
export function createGameState(options: CreateWorldOptions): GameState {
  const runtime = new BotRuntime();
  try {
    return {
      version: 1,
      world: createWorld(options),
      runtime: runtime.snapshot(),
      branches: {},
      history: {},
      statistics: [],
      leaderboard: {},
      jobs: {},
      pendingIntents: {},
      pendingGlobalIntents: {},
    };
  } finally {
    runtime.dispose();
  }
}

/**
 * The game fields of `state` (shared, not copied). Host records stored next to them — accounts,
 * credentials, sessions — are left out.
 */
export function gameStateOf(state: GameState): GameState {
  const result: Partial<Record<keyof GameState, unknown>> = {};
  for (const key of Object.keys(GAME_STATE_FIELDS) as Array<keyof GameState>) {
    result[key] = state[key];
  }
  return result as GameState;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function entriesMatch(value: unknown, check: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

function modules(value: unknown): boolean {
  return entriesMatch(
    value,
    (entry) => typeof entry === 'string' || (isRecord(entry) && typeof entry.binary === 'string'),
  );
}

const WORLD_COLLECTIONS = [
  'rooms',
  'roomObjects',
  'flags',
  'users',
  'userPowerCreeps',
  'marketOrders',
  'transactions',
  'usersMoney',
  'usersResources',
  'notifications',
  'marketStats',
  'mapViews',
] as const;

const GAME_COLLECTIONS: Readonly<Record<string, (entry: unknown) => boolean>> = {
  branches: (entry) =>
    isRecord(entry) &&
    ['_id', 'user', 'branch'].every((key) => typeof entry[key] === 'string') &&
    modules(entry.modules) &&
    typeof entry.activeWorld === 'boolean' &&
    typeof entry.activeSim === 'boolean' &&
    finite(entry.timestamp),
  history: (entry) =>
    Array.isArray(entry) &&
    entry.every(
      (frame: unknown) =>
        isRecord(frame) &&
        Number.isSafeInteger(frame.time) &&
        entriesMatch(frame.objects, isRecord),
    ),
  leaderboard: (entry) =>
    entriesMatch(entry, (score) => isRecord(score) && finite(score.world) && finite(score.power)),
  jobs: finite,
  pendingIntents: (entry) => entriesMatch(entry, (targets) => entriesMatch(targets, isRecord)),
  pendingGlobalIntents: (entry) =>
    entriesMatch(entry, (intents) => Array.isArray(intents) && intents.every(isRecord)),
};

function validateWorld(world: Record<string, unknown>): void {
  if (
    !Number.isSafeInteger(world.gameTime) ||
    typeof world.shardName !== 'string' ||
    !Number.isSafeInteger(world.idCounter) ||
    typeof world.rngState !== 'number' ||
    !strings(world.activeRooms) ||
    typeof world.restrictedShard !== 'boolean'
  ) {
    throw new Error('Invalid world snapshot');
  }
  for (const name of [...WORLD_COLLECTIONS, 'terrain', 'roomEventLogs']) {
    if (!isRecord(world[name])) throw new Error(`Invalid world collection: ${name}`);
  }
}

function validateStatistics(statistics: unknown): void {
  if (
    !Array.isArray(statistics) ||
    !statistics.every(
      (sample: unknown) =>
        isRecord(sample) &&
        finite(sample.time) &&
        Number.isSafeInteger(sample.tick) &&
        Number.isSafeInteger(sample.ticks) &&
        entriesMatch(sample.rooms, (users) =>
          entriesMatch(users, (stats) => entriesMatch(stats, finite)),
        ) &&
        entriesMatch(
          sample.users,
          (user) =>
            isRecord(user) &&
            ['cpu', 'memory', 'bucket', 'gcl', 'power'].every((key) => finite(user[key])),
        ),
    )
  ) {
    throw new Error('Invalid game statistics');
  }
}

function validateRuntime(runtime: Record<string, unknown>): void {
  if (runtime.version !== 1 || !isRecord(runtime.users) || !isRecord(runtime.interShard)) {
    throw new Error('Invalid runtime snapshot');
  }
  if (
    !finite(runtime.lastCodeTimestamp) ||
    !entriesMatch(
      runtime.users,
      (user) =>
        isRecord(user) &&
        modules(user.modules) &&
        typeof user.branch === 'string' &&
        finite(user.codeTimestamp) &&
        typeof user.memory === 'string' &&
        entriesMatch(user.segments, (segment) => typeof segment === 'string') &&
        Array.isArray(user.activeSegments) &&
        user.activeSegments.every(Number.isSafeInteger) &&
        Array.isArray(user.consoleCommands) &&
        user.consoleCommands.every(
          (command: unknown) => isRecord(command) && typeof command.expression === 'string',
        ),
    )
  ) {
    throw new Error('Invalid player runtime snapshot');
  }
  const interShard = runtime.interShard;
  if (
    !entriesMatch(interShard.data, (users) =>
      entriesMatch(users, (data) => typeof data === 'string'),
    ) ||
    !entriesMatch(interShard.segments, (segment) => typeof segment === 'string') ||
    !entriesMatch(interShard.defaultLimits, (limits) => entriesMatch(limits, finite)) ||
    !entriesMatch(
      interShard.shardLimits,
      (entry) =>
        isRecord(entry) && finite(entry.cooldownTime) && entriesMatch(entry.limits, finite),
    )
  ) {
    throw new Error('Invalid inter-shard snapshot');
  }
}

/**
 * Validates an untrusted snapshot (for example parsed JSON) before it may replace a live world and
 * returns it typed. Fails closed on any malformed nested record. Other top-level fields (host
 * records) are neither checked nor removed.
 */
export function parseGameState<T>(value: T): T & GameState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Unsupported or invalid game snapshot');
  }
  const world = value.world;
  const runtime = value.runtime;
  if (!isRecord(world)) throw new Error('Unsupported or invalid game snapshot');
  validateWorld(world);
  if (!isRecord(runtime)) throw new Error('Invalid runtime snapshot');
  for (const [name, check] of Object.entries(GAME_COLLECTIONS)) {
    if (!entriesMatch(value[name], check)) throw new Error(`Invalid game collection: ${name}`);
  }
  validateStatistics(value.statistics);
  validateRuntime(runtime);
  if (
    !entriesMatch(
      world.terrain,
      (terrain) => typeof terrain === 'string' && /^[0-3]{2500}$/.test(terrain),
    )
  ) {
    throw new Error('Invalid world terrain');
  }
  for (const name of WORLD_COLLECTIONS) {
    if (!entriesMatch(world[name], isRecord)) throw new Error(`Invalid world collection: ${name}`);
  }
  if (
    !entriesMatch(world.roomEventLogs, (events) => Array.isArray(events) && events.every(isRecord))
  ) {
    throw new Error('Invalid room event logs');
  }
  return value as T & GameState;
}
