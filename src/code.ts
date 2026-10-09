/*
 * Player code branches (backend `users.code` documents). The runtime always runs the player's
 * `activeWorld` branch; every change to that branch is mirrored into the runtime immediately.
 */

import type { CodeModules } from '@openscreeps/engine';
import {
  GameError,
  newId,
  type CodeBranch,
  type GameContext,
  type GameState,
} from './contracts.ts';
import { isRecord } from './guards.ts';

/** Most branches a player can keep (tutorial branches excepted). */
export const MAX_BRANCHES = 30;

export type ActiveBranchName = 'activeWorld' | 'activeSim';

/**
 * Backend `translateModulesToDb` semantics on untrusted input: module names whose stored form
 * would start with `$` (leading `$`, `.`, `/` or `\`) are dropped and `main` always exists.
 * Values are source text or `{binary: base64}`; anything else is `invalid params`.
 */
export function normalizeModules(value: unknown): CodeModules {
  if (!isRecord(value)) throw new GameError('invalid params');
  const modules: CodeModules = {};
  for (const [name, source] of Object.entries(value)) {
    if (/^[$./\\]/.test(name) || name === '__proto__') continue;
    if (typeof source === 'string') {
      modules[name] = source;
    } else if (isRecord(source) && typeof source.binary === 'string') {
      modules[name] = { binary: source.binary };
    } else {
      throw new GameError('invalid params');
    }
  }
  if (modules.main === undefined) modules.main = '';
  return modules;
}

export function userBranches(state: GameState, userId: string): CodeBranch[] {
  return Object.values(state.branches).filter((branch) => branch.user === userId);
}

/** Backend branch query: `$activeWorld` / `$activeSim` select the active branch, else by name. */
export function findBranch(
  state: GameState,
  userId: string,
  selector: string,
): CodeBranch | undefined {
  const branches = userBranches(state, userId);
  if (selector === '$activeWorld') return branches.find((branch) => branch.activeWorld);
  if (selector === '$activeSim') return branches.find((branch) => branch.activeSim);
  return branches.find((branch) => branch.branch === selector);
}

function syncWorldCode(context: GameContext, branch: CodeBranch): void {
  if (branch.activeWorld) context.runtime.setCode(branch.user, branch.modules, branch.branch);
}

/** A new branch document; like upstream it has no `activeWorld`/`activeSim` flags until set. */
function createBranch(
  state: GameState,
  userId: string,
  name: string,
  modules: CodeModules,
  timestamp: number,
): CodeBranch {
  const branch: CodeBranch = {
    _id: newId(state),
    user: userId,
    branch: name,
    modules,
    timestamp,
  };
  state.branches[branch._id] = branch;
  return branch;
}

/** The player's branches, creating an inactive empty `default` branch when it is missing. */
export function listBranches(context: GameContext, userId: string): CodeBranch[] {
  const { state } = context;
  if (!userBranches(state, userId).some((branch) => branch.branch === 'default')) {
    createBranch(state, userId, 'default', { main: '' }, context.now());
  }
  return userBranches(state, userId);
}

/**
 * Replaces the modules of the branch `selector` names (default the world branch) and runs the code
 * from the next tick when it is the world branch. The player is marked active first, as upstream
 * does even when the branch then turns out not to exist.
 */
export function saveCode(
  context: GameContext,
  userId: string,
  modules: CodeModules,
  selector = '$activeWorld',
): CodeBranch {
  const user = context.state.world.users[userId];
  if (user) user.active = 10000;
  const branch = findBranch(context.state, userId, selector);
  if (!user || !branch) throw new GameError('branch does not exist');
  branch.modules = structuredClone(modules);
  branch.timestamp = context.now();
  syncWorldCode(context, branch);
  return branch;
}

/** Makes the named branch the player's world or simulation branch. */
export function setActiveBranch(
  context: GameContext,
  userId: string,
  activeName: ActiveBranchName,
  name: unknown,
): CodeBranch {
  const branches = userBranches(context.state, userId);
  const target =
    typeof name === 'string' ? branches.find((branch) => branch.branch === name) : undefined;
  if (!target) throw new GameError('no branch');
  for (const branch of branches) branch[activeName] = false;
  target[activeName] = true;
  if (activeName === 'activeWorld') syncWorldCode(context, target);
  return target;
}

export interface CloneBranchOptions {
  /** Validated branch name to copy; absent copies `defaultModules`. */
  source?: string;
  /** Validated new branch name; an existing branch of that name is overwritten. */
  newName: string;
  /** Untrusted module map used without `source`; default `{main: ''}`. */
  defaultModules?: unknown;
}

/** Copies a branch (or default modules) into a new or existing branch. */
export function cloneBranch(
  context: GameContext,
  userId: string,
  options: CloneBranchOptions,
): CodeBranch {
  const { state } = context;
  const { source, newName, defaultModules } = options;
  const branches = userBranches(state, userId);
  const existing = branches.find((branch) => branch.branch === newName);
  if (!existing && !/^tutorial-\d$/.test(newName) && branches.length >= MAX_BRANCHES) {
    throw new GameError('too many branches');
  }
  const sourceBranch =
    source !== undefined && source !== ''
      ? branches.find((branch) => branch.branch === source)
      : undefined;
  const modules = sourceBranch
    ? structuredClone(sourceBranch.modules)
    : defaultModules
      ? normalizeModules(defaultModules)
      : { main: '' };
  const now = context.now();
  if (existing) {
    existing.modules = modules;
    existing.timestamp = now;
    syncWorldCode(context, existing);
    return existing;
  }
  return createBranch(state, userId, newName, modules, now);
}

/** Deletes the named branch unless it is active in the world or simulation. */
export function deleteBranch(state: GameState, userId: string, name: unknown): void {
  for (const branch of userBranches(state, userId)) {
    if (branch.branch === name && !branch.activeWorld && !branch.activeSim) {
      Reflect.deleteProperty(state.branches, branch._id);
    }
  }
}

/**
 * Upstream `utils.reloadBotUsers` for one player: a fresh branch named `branch` holding `modules`
 * (active in world and simulation) replaces every other branch of the player.
 */
export function replaceBranches(
  context: GameContext,
  userId: string,
  modules: CodeModules,
  branch: string,
  timestamp = context.now(),
): CodeBranch {
  const { state } = context;
  for (const [id, existing] of Object.entries(state.branches)) {
    if (existing.user === userId) Reflect.deleteProperty(state.branches, id);
  }
  const id = newId(state);
  const created: CodeBranch = {
    _id: id,
    user: userId,
    branch,
    modules: structuredClone(modules),
    activeWorld: true,
    activeSim: true,
    timestamp,
  };
  state.branches[id] = created;
  context.runtime.setCode(userId, modules, branch);
  return created;
}
