/*
 * A live headless world: the state, the player runtime and the simulation, advanced one explicit
 * tick at a time. Hosts own scheduling, persistence and accounts; the session owns the tick.
 */

import {
  BotRuntime,
  Simulation,
  worldConstants,
  type BotRuntimeOptions,
  type CodeModules,
  type Constants,
  type SimulationOptions,
  type StoredUserIntents,
  type TickResult,
  type TickRunResult,
} from '@openscreeps/engine';
import { saveCode } from './code.ts';
import type { CodeBranch, GameContext, GameState, User } from './contracts.ts';
import { createPlayer, removePlayer, type CreatePlayerOptions } from './players.ts';
import { recordHistory, recordLeaderboard, recordStatistics } from './records.ts';
import { gameStateOf } from './state.ts';
import { spawnBot, type SpawnBotOptions } from './world/bots.ts';
import {
  runMaintenance,
  type MaintenanceHooks,
  type MaintenanceReport,
} from './world/maintenance.ts';

export interface GameTick {
  simulation: TickResult;
  runtime: TickRunResult;
  /** Wall-clock start of the tick: maintenance schedule, statistics minute, leaderboard season. */
  timestamp: number;
  /** Maintenance jobs run before the tick, their failures and produced notification batches. */
  maintenance: MaintenanceReport;
}

/** Simulation options the session leaves to the host (it owns state sharing, clock and history). */
export type SessionSimulationOptions = Omit<
  SimulationOptions,
  'stateOwnership' | 'now' | 'recordHistory' | 'constants'
>;

export interface GameSessionOptions<S extends GameState> {
  /** State the session adopts and mutates in place (never copied); see `GameSession.adopt`. */
  state: S;
  /** Wall clock; default `Date.now`. */
  now?: () => number;
  /** Ticks of room history kept for replay; default 0 records no history. */
  historyTicks?: number;
  /** History chunk length; one extra chunk is retained so complete chunks stay readable. */
  historyChunkSize?: number;
  /** Player runtime limits and mods. */
  runtime?: Omit<BotRuntimeOptions, 'snapshot' | 'now' | 'constants'>;
  /** Simulation options such as processor hooks for server mods. */
  simulation?: SessionSimulationOptions;
  /** Host account data consulted by maintenance (notification preferences). */
  hooks?: MaintenanceHooks;
  /**
   * Whether every tick first runs due maintenance (default `true`). Hosts that run maintenance on
   * their own clock (upstream's one-second backend timer) pass `false`; ticks then report no jobs.
   */
  maintenance?: boolean;
  /**
   * The world's constants (server mods' `config.common.constants`, from `createConstants()`), used
   * by the simulation, the player runtime and every game operation on the session's world. Default:
   * the constants bound to `state.world` (see `createGameState`), else the upstream values.
   */
  constants?: Constants;
}

export interface AdoptOptions {
  /**
   * `restart` (default) disposes the live player isolates and restarts every player from
   * `state.runtime`, as after a server restart (global reset). `preserve` keeps the live runtime and
   * its heaps when `state.runtime` equals its snapshot, restarting only when they differ.
   */
  runtime?: 'restart' | 'preserve';
  /**
   * Whether room terrain changed since the live runtime last loaded it (default `false`). With a
   * preserved runtime pass the pending invalidation of the adopted state, so the next tick still
   * reloads player terrain caches.
   */
  terrainDirty?: boolean;
}

/**
 * Runs one world. `tick()` is asynchronous (player scripts run in isolates); every other method is
 * synchronous. While a tick is in flight (`ticking`), the session's own methods — `tick`,
 * `terrainChanged`, `syncRuntime`, `snapshot`, `restore`, `adopt`, `createPlayer`, `removePlayer`,
 * `saveCode`, `spawnBot` and `dispose` — throw. Exported free functions (world, code, player and
 * domain operations taking this session as their `GameContext` or its `state`), direct writes to
 * `state` and calls on `runtime` are not guarded: callers must run them only between ticks, e.g.
 * by awaiting `tick()` or serializing all work through one queue as the server does.
 *
 * The session shares its state object: hosts may store extra top-level records in it (`S`), which
 * the session never reads, and which `snapshot()` excludes.
 */
export class GameSession<S extends GameState = GameState> implements GameContext<S>, Disposable {
  readonly #now: () => number;
  readonly #historyTicks: number;
  readonly #historyChunkSize: number;
  readonly #runtimeOptions: Omit<BotRuntimeOptions, 'snapshot' | 'now' | 'constants'>;
  readonly #simulationOptions: SessionSimulationOptions;
  readonly #hooks: MaintenanceHooks;
  readonly #maintenance: boolean;
  readonly #constants: Constants;
  #state: S;
  #runtime: BotRuntime;
  #simulation: Simulation;
  #terrainDirty = false;
  #ticking = false;
  #disposed = false;

  constructor(options: GameSessionOptions<S>) {
    this.#now = options.now ?? Date.now;
    this.#historyTicks = options.historyTicks ?? 0;
    this.#historyChunkSize = options.historyChunkSize ?? 0;
    this.#runtimeOptions = options.runtime ?? {};
    this.#simulationOptions = options.simulation ?? {};
    this.#hooks = options.hooks ?? {};
    this.#maintenance = options.maintenance ?? true;
    this.#constants = options.constants ?? worldConstants(options.state.world);
    this.#state = options.state;
    this.#runtime = this.#createRuntime(options.state);
    this.#simulation = this.#createSimulation(options.state);
  }

  get state(): S {
    return this.#state;
  }
  get runtime(): BotRuntime {
    return this.#runtime;
  }
  /** A terrain change awaits the next tick's pathfinding refresh. */
  get terrainDirty(): boolean {
    return this.#terrainDirty;
  }
  /** A tick is in flight; state operations are rejected until it settles. */
  get ticking(): boolean {
    return this.#ticking;
  }
  /** The world's constants object (shared by reference). */
  get constants(): Constants {
    return this.#constants;
  }
  now(): number {
    return this.#now();
  }

  #createRuntime(state: S): BotRuntime {
    return new BotRuntime({
      ...this.#runtimeOptions,
      snapshot: state.runtime,
      now: this.#now,
      constants: this.#constants,
    });
  }

  /** The simulation shares `state.world` and binds it to the session's constants. */
  #createSimulation(state: S): Simulation {
    return new Simulation(state.world, {
      ...this.#simulationOptions,
      stateOwnership: 'shared',
      now: this.#now,
      recordHistory: this.#historyTicks > 0,
      constants: this.#constants,
    });
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error('Game session is disposed');
    if (this.#ticking) throw new Error('A game tick is running');
  }

  terrainChanged(): void {
    this.#assertIdle();
    this.#terrainDirty = true;
  }

  /**
   * Advances the world one tick: due maintenance jobs (unless disabled), a pending terrain refresh,
   * every player's script, queued manual intents, the simulation, then history, statistics and
   * leaderboard records.
   */
  async tick(): Promise<GameTick> {
    this.#assertIdle();
    this.#ticking = true;
    try {
      return await this.#tick();
    } finally {
      this.#ticking = false;
    }
  }

  async #tick(): Promise<GameTick> {
    const state = this.#state;
    const timestamp = this.#now();
    const maintenance: MaintenanceReport = this.#maintenance
      ? runMaintenance(state, timestamp, this.#hooks)
      : { ran: [], errors: [], notifications: [] };
    if (this.#terrainDirty) {
      this.#simulation.refreshTerrain();
      this.#runtime.refreshTerrain();
      this.#terrainDirty = false;
    }
    const runtime = await this.#runtime.runTick(state.world);
    for (const [userId, global] of Object.entries(state.pendingGlobalIntents)) {
      const user: StoredUserIntents = (runtime.intents[userId] ??= { rooms: {} });
      const destination = (user.global ??= {});
      for (const [name, intents] of Object.entries(global)) {
        const key = name as keyof typeof global;
        // Different intent names have different payload types; each source list retains its name.
        const target = destination as Record<string, unknown[]>;
        if (Array.isArray(intents)) {
          const list: unknown[] = intents;
          (target[key] ??= []).push(...list);
        }
      }
    }
    const simulation = await this.#simulation.tickAsync(runtime.intents, state.pendingIntents);
    state.pendingIntents = {};
    state.pendingGlobalIntents = {};
    for (const [userId, result] of Object.entries(runtime.users)) {
      const user = state.world.users[userId];
      if (user && Number.isFinite(result.cpu.bucket)) user.cpuAvailable = result.cpu.bucket;
    }
    recordHistory(state, simulation, this.#historyTicks, this.#historyChunkSize);
    recordStatistics(state, simulation, runtime, timestamp);
    recordLeaderboard(state, simulation.roomStats, timestamp);
    return { simulation, runtime, timestamp, maintenance };
  }

  /** Stores the live runtime snapshot in `state.runtime`, as persisted snapshots require. */
  syncRuntime(): void {
    this.#assertIdle();
    this.#state.runtime = this.#runtime.snapshot();
  }

  /**
   * An isolated deep copy of the game fields with the live runtime snapshot. Host records kept in
   * the state (accounts, credentials, sessions) are never included.
   */
  snapshot(): GameState {
    this.#assertIdle();
    const snapshot = structuredClone({ ...gameStateOf(this.#state), runtime: undefined });
    return { ...snapshot, runtime: this.#runtime.snapshot() };
  }

  /**
   * Replaces the game fields with a copy of `snapshot` and restarts the player runtime from it;
   * host records in the current state are kept. Validate untrusted input with `parseGameState`.
   */
  restore(snapshot: GameState): void {
    this.#assertIdle();
    const game = structuredClone(gameStateOf(snapshot));
    this.adopt({ ...this.#state, ...game });
  }

  /**
   * Makes `state` the live world without copying it (hosts use this to reinstate a committed state
   * or import a validated one) and rebuilds the simulation; see `AdoptOptions` for the runtime.
   */
  adopt(state: S, options: AdoptOptions = {}): void {
    this.#assertIdle();
    const simulation = this.#createSimulation(state);
    if (
      options.runtime !== 'preserve' ||
      JSON.stringify(this.#runtime.snapshot()) !== JSON.stringify(state.runtime)
    ) {
      const runtime = this.#createRuntime(state);
      this.#runtime.dispose();
      this.#runtime = runtime;
    }
    this.#state = state;
    this.#simulation = simulation;
    this.#terrainDirty = options.terrainDirty ?? false;
  }

  /** Creates a player with a `default` code branch running `options.modules`. */
  createPlayer(options: CreatePlayerOptions): User {
    this.#assertIdle();
    return createPlayer(this, options);
  }

  /** Deletes a player, turning its structures into ruins (see `removePlayer`). */
  removePlayer(userId: string): void {
    this.#assertIdle();
    removePlayer(this, userId);
  }

  /** Replaces the code of a player's branch (default the world branch); see `saveCode`. */
  saveCode(userId: string, modules: CodeModules, branch?: string): CodeBranch {
    this.#assertIdle();
    return saveCode(this, userId, modules, branch);
  }

  /** Creates an NPC player owning `room` with a spawn; see `spawnBot`. */
  spawnBot(
    botAiName: string,
    modules: CodeModules,
    room: string,
    options?: SpawnBotOptions,
  ): { userId: string; username: string } {
    this.#assertIdle();
    return spawnBot(this, botAiName, modules, room, options);
  }

  /** Disposes the player isolates. Idempotent; rejected while a tick is in flight. */
  dispose(): void {
    if (this.#disposed) return;
    if (this.#ticking) throw new Error('A game tick is running');
    this.#disposed = true;
    this.#runtime.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
