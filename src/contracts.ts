import type {
  BotRuntime,
  CodeModules,
  ManualIntents,
  RuntimeSnapshot,
  StoredUserIntents,
  TickResult,
  WorldState,
} from '@openscreeps/engine';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type User = WorldState['users'][string];
export type RoomObject = WorldState['roomObjects'][string];

export interface CustomBadgePaths {
  path1: string;
  path2: string;
}
/** Player badge (`users.badge`). */
export interface Badge {
  type: number | CustomBadgePaths;
  /** `#rrggbb`, or an index into the legacy badge palette. */
  color1: string | number;
  color2: string | number;
  color3: string | number;
  param: number;
  flip: boolean;
}

export interface CodeBranch {
  _id: string;
  user: string;
  branch: string;
  modules: CodeModules;
  /** Absent on branches created without an active flag (upstream branch listing/cloning). */
  activeWorld?: boolean;
  activeSim?: boolean;
  /** Last code save; absent until code is first saved (upstream default branches have none). */
  timestamp?: number;
}
export interface HistoryFrame {
  time: number;
  objects: Record<string, unknown>;
}
export interface StatisticsSample {
  /** Minute bucket start in wall-clock milliseconds; room increments accumulate in this bucket. */
  time: number;
  tick: number;
  ticks: number;
  rooms: TickResult['roomStats'];
  users: Record<
    string,
    { cpu: number; memory: number; bucket: number; gcl: number; power: number }
  >;
}
/** Monthly scores of one player: control points upgraded (`world`) and power processed. */
export interface LeaderboardScores {
  world: number;
  power: number;
}

/**
 * Persistent, credential-free state of one headless game world. Hosts may extend it with their own
 * top-level records (accounts, sessions, scheduling); game code reads and writes only these fields.
 */
export interface GameState {
  version: 1;
  world: WorldState;
  /** Player code, memory and inter-shard data; refreshed from the live runtime before persisting. */
  runtime: RuntimeSnapshot;
  /** Code branches of every player (`users.code` documents). */
  branches: Record<string, CodeBranch>;
  /** Recorded room history frames by room name. */
  history: Record<string, HistoryFrame[]>;
  /** Per-minute room and player statistics of the last seven days. */
  statistics: StatisticsSample[];
  /** Scores by season (`YYYY-MM`) and user id. */
  leaderboard: Record<string, Record<string, LeaderboardScores>>;
  /** Last-run timestamps of maintenance jobs and per-room/per-user scheduler metadata. */
  jobs: Record<string, number>;
  /** Manual (non-script) room intents applied by the next tick. */
  pendingIntents: ManualIntents;
  /** Manual global intents by user, merged into the players' script intents by the next tick. */
  pendingGlobalIntents: Record<string, NonNullable<StoredUserIntents['global']>>;
}

/** The live world operations work on: its state, player runtime and clock. */
export interface GameContext<S extends GameState = GameState> {
  readonly state: S;
  readonly runtime: BotRuntime;
  now(): number;
  /** Call after changing room terrain; refreshes engine pathfinding before the next tick. */
  terrainChanged(): void;
}

/** A rejected game operation; the message is the client-facing reason. */
export class GameError extends Error {
  override name = 'GameError';
}

/** Allocates the next 24-hex-digit document id from the world counter. */
export function newId(state: GameState): string {
  return (++state.world.idCounter).toString(16).padStart(24, '0');
}
