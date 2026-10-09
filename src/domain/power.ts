import { constants as C, recordRoomObjectWrite, type WorldState } from '@openscreeps/engine';
import { GameError, newId, type GameState, type User } from '../contracts.ts';
import { gameUser, ownValue, type GameOperationContext } from './support.ts';

export type PowerCreepDoc = WorldState['userPowerCreeps'][string];
type PowerLevels = PowerCreepDoc['powers'];
/** A power creep document merged with its room object while spawned. */
export type SpawnedPowerCreep = Omit<PowerCreepDoc, keyof WorldState['roomObjects'][string]> &
  WorldState['roomObjects'][string];

export interface CreatePowerCreepInput {
  className?: string | undefined;
  /** Any request value; stored as upstream `("" + name).substring(0, 50)`. */
  name?: unknown;
}

export interface UpgradePowerCreepInput {
  id?: string | undefined;
  /** Requested level per power id. */
  powers?: Readonly<Record<string, unknown>> | undefined;
}

export interface RenamePowerCreepInput {
  id?: string | undefined;
  /** Any request value; stored as upstream `("" + name).substring(0, 50)`. */
  name?: unknown;
}

const POWER_INFO: Readonly<
  Record<string, { readonly className: string; readonly level: readonly number[] }>
> = C.POWER_INFO;
const POWER_CLASSES: readonly string[] = Object.values(C.POWER_CLASS);
const MAX_POWER_LEVEL = 5;
const EXPERIMENTATION_DURATION = 24 * 3600 * 1000;

function userPowerCreeps(world: WorldState, userId: string): PowerCreepDoc[] {
  return Object.values(world.userPowerCreeps).filter((creep) => creep.user === userId);
}

/** Upstream `calcFreePowerLevels`: GPL minus one level per creep and every upgraded creep level. */
function freePowerLevels(user: User, creeps: readonly PowerCreepDoc[]): number {
  const level = Math.floor(
    Math.pow((user.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW),
  );
  return level - creeps.length - creeps.reduce((sum, creep) => sum + creep.level, 0);
}

/** A power creep of the user, or `invalid id` (never reveals other players' creeps). */
function ownPowerCreep(world: WorldState, userId: string, id: string | undefined): PowerCreepDoc {
  const creep = ownValue(world.userPowerCreeps, id);
  if (!creep || creep.user !== userId) {
    throw new GameError('invalid id');
  }
  return creep;
}

function isSpawned(creep: PowerCreepDoc): boolean {
  return creep.spawnCooldownTime === null || !!creep.shard;
}

/**
 * Upstream `powersAreValid`: the requested levels must be reachable by taking one power level at a
 * time, each only once the creep level reaches that power's level requirement.
 */
function powersAreValid(powers: Readonly<Record<string, number>>): boolean {
  const finalLevel = Object.values(powers).reduce((sum, value) => sum + value, 0);
  const levels: Record<string, number> = {};
  for (const power of Object.keys(POWER_INFO)) {
    levels[power] = 0;
  }
  let level = 0;
  while (level < finalLevel) {
    const power = Object.keys(powers).find((key) => {
      const current = levels[key] ?? 0;
      const required = POWER_INFO[key]?.level[current];
      return (
        current < MAX_POWER_LEVEL &&
        current < (powers[key] ?? 0) &&
        required !== undefined &&
        required <= level
      );
    });
    if (power === undefined) {
      return false;
    }
    levels[power] = (levels[power] ?? 0) + 1;
    level = Object.values(levels).reduce((sum, value) => sum + value, 0);
  }
  return true;
}

/**
 * Validates an upgrade request like upstream `/upgrade`, returning the new power levels. Unlike
 * upstream (`_.isNumber`), a level must also be a whole number: the processors index power effects
 * by level, so a fractional level would give the creep undefined effects on other players' objects.
 */
function readUpgrade(
  creep: PowerCreepDoc,
  input: Readonly<Record<string, unknown>> | undefined,
): Record<string, number> {
  if (!input) {
    throw new GameError('invalid powers');
  }
  const powers: Record<string, number> = {};
  for (const [power, value] of Object.entries(input)) {
    const info = ownValue(POWER_INFO, power);
    if (!info) {
      throw new GameError(`invalid power ${power}`);
    }
    if (info.className !== creep.className) {
      throw new GameError(`invalid class for power ${power}`);
    }
    if (typeof value !== 'number') {
      throw new GameError(`invalid value for power ${power}`);
    }
    if (value < (ownValue(creep.powers, power)?.level ?? 0)) {
      throw new GameError(`cannot downgrade power ${power}`);
    }
    if (value > MAX_POWER_LEVEL) {
      throw new GameError(`invalid max value for power ${power}`);
    }
    if (!Number.isInteger(value)) {
      throw new GameError(`invalid value for power ${power}`);
    }
    powers[power] = value;
  }
  for (const [power, info] of Object.entries(creep.powers)) {
    if ((ownValue(powers, power) ?? 0) < info.level) {
      throw new GameError(`cannot downgrade power ${power}`);
    }
  }
  const newLevel = Object.values(powers).reduce((sum, value) => sum + value, 0);
  if (newLevel > C.POWER_CREEP_MAX_LEVEL) {
    throw new GameError('max level');
  }
  for (const [power, value] of Object.entries(powers)) {
    const required = POWER_INFO[power]?.level[value - 1];
    if (value !== 0 && required !== undefined && newLevel < required) {
      throw new GameError(`not enough level for power ${power}`);
    }
  }
  if (!powersAreValid(powers)) {
    throw new GameError('powers set is not valid');
  }
  return powers;
}

/** Upstream `$merge` of `{level}` into each upgraded power (existing cooldowns are kept). */
function mergePowers(
  current: PowerLevels | undefined,
  powers: Readonly<Record<string, number>>,
): PowerLevels {
  const merged: PowerLevels = {};
  for (const [power, info] of Object.entries(current ?? {})) {
    merged[power] = { ...info };
  }
  for (const [power, level] of Object.entries(powers)) {
    if (level !== 0) {
      merged[power] = { ...ownValue(merged, power), level };
    }
  }
  return merged;
}

/** The user's power creeps, merged with their room objects while spawned (copies). */
export function listPowerCreeps(
  world: WorldState,
  userId: string,
): Array<PowerCreepDoc | SpawnedPowerCreep> {
  return userPowerCreeps(world, userId).map((creep) => {
    const object = ownValue(world.roomObjects, creep._id);
    return object?.type === 'powerCreep' && object.user === userId
      ? { ...creep, ...object }
      : { ...creep };
  });
}

/** Upstream `/power-creeps/create`; returns a copy of the new creep document. */
export function createPowerCreep(
  state: GameState,
  userId: string,
  input: CreatePowerCreepInput,
): PowerCreepDoc {
  const user = gameUser(state.world, userId);
  const creeps = userPowerCreeps(state.world, userId);
  if (freePowerLevels(user, creeps) <= 0) {
    throw new GameError('not enough power level');
  }
  const { className } = input;
  if (className === undefined || !POWER_CLASSES.includes(className)) {
    throw new GameError('invalid class');
  }
  const name = String(input.name).substring(0, 50);
  if (creeps.some((creep) => creep.name === name)) {
    throw new GameError('name already exists');
  }
  const creep: PowerCreepDoc = {
    _id: newId(state),
    name,
    className,
    user: userId,
    level: 0,
    hitsMax: 1000,
    store: {},
    storeCapacity: 100,
    spawnCooldownTime: 0,
    powers: {},
  };
  state.world.userPowerCreeps[creep._id] = creep;
  return { ...creep };
}

/**
 * Upstream `/power-creeps/delete`: immediate during power experimentation, otherwise scheduled
 * after the delete cooldown.
 */
export function deletePowerCreep(game: GameOperationContext, userId: string, id?: string): void {
  const { world } = game.state;
  const user = gameUser(world, userId);
  const creep = ownPowerCreep(world, userId, id);
  if (isSpawned(creep)) {
    throw new GameError('spawned');
  }
  if (creep.deleteTime) {
    throw new GameError('already being deleted');
  }
  const now = game.now();
  if ((user.powerExperimentationTime || 0) > now) {
    Reflect.deleteProperty(world.userPowerCreeps, creep._id);
  } else {
    creep.deleteTime = now + C.POWER_CREEP_DELETE_COOLDOWN;
  }
}

export function cancelPowerCreepDelete(state: GameState, userId: string, id?: string): void {
  const creep = ownPowerCreep(state.world, userId, id);
  if (!creep.deleteTime) {
    throw new GameError('not being deleted');
  }
  delete creep.deleteTime;
}

/** Upstream `/power-creeps/upgrade`, applied to the document and its spawned room object. */
export function upgradePowerCreep(
  state: GameState,
  userId: string,
  input: UpgradePowerCreepInput,
): void {
  const { world } = state;
  const user = gameUser(world, userId);
  const creeps = userPowerCreeps(world, userId);
  const creep = ownPowerCreep(world, userId, input.id);
  const powers = readUpgrade(creep, input.powers);
  const level = Object.values(powers).reduce((sum, value) => sum + value, 0);
  if (freePowerLevels(user, creeps) < level - creep.level) {
    throw new GameError('not enough power level');
  }
  const hitsMax = 1000 * (level + 1);
  const storeCapacity = 100 * (level + 1);
  Object.assign(creep, {
    powers: mergePowers(creep.powers, powers),
    level,
    hitsMax,
    storeCapacity,
  });
  const object = ownValue(world.roomObjects, creep._id);
  if (object?.type === 'powerCreep' && object.user === userId) {
    Object.assign(object, {
      powers: mergePowers(object.powers, powers),
      level,
      hitsMax,
      storeCapacity,
    });
    recordRoomObjectWrite(world, object._id);
  }
}

export function renamePowerCreep(
  state: GameState,
  userId: string,
  input: RenamePowerCreepInput,
): void {
  const { world } = state;
  const creep = ownPowerCreep(world, userId, input.id);
  if (isSpawned(creep)) {
    throw new GameError('spawned');
  }
  const name = String(input.name).substring(0, 50);
  if (userPowerCreeps(world, userId).some((other) => other.name === name)) {
    throw new GameError('name already exists');
  }
  creep.name = name;
}

/** Upstream `/power-creeps/experimentation`: spends one reset for a day of free power changes. */
export function startPowerExperimentation(game: GameOperationContext, userId: string): void {
  const user = gameUser(game.state.world, userId);
  if ((user.powerExperimentations || 0) <= 0) {
    throw new GameError('no power resets');
  }
  user.powerExperimentations = (user.powerExperimentations || 0) - 1;
  user.powerExperimentationTime = game.now() + EXPERIMENTATION_DURATION;
}
