import type {
  CodeModules,
  Constants,
  GameContext,
  GameState,
  MaintenanceHooks,
} from '../../src/index.ts';
import type * as GameExports from '../../src/index.ts';
import type { Controls } from './controls.ts';
import type { Oracle } from './oracle.ts';
export type Game = typeof GameExports;
export type { Controls, Oracle };
export interface Document {
  [field: string]: unknown;
}
export interface EnvData {
  [key: string]: unknown;
  gameTime?: string | number;
  activeRooms?: string[];
}
export interface Dump {
  collections: Record<string, Document[]>;
  env: { data: EnvData }[];
}
export interface View {
  collections: Record<string, Document[]>;
  env: {
    gameTime: number;
    activeRooms: string[];
    memory: Record<string, unknown>;
    mapViews: Record<string, unknown>;
  };
  unmappedEnv?: Record<string, unknown>;
}
export interface Local {
  state: GameState;
  runtime: GameContext['runtime'];
  profiles: Record<string, Document>;
  context: GameContext;
  hooks: MaintenanceHooks;
}
export type Side = 'upstream' | 'local';
export type Outcome = { ok: true; value: unknown } | { ok: false; error: string };
export interface Difference {
  collection: string;
  key: string;
  path: string;
  upstream: unknown;
  local: unknown;
}
export interface ScenarioContext {
  oracle: Oracle;
  local: Local;
  controls: Controls;
}
export interface Helpers {
  C: Constants;
}
export type Projection = (outcome: Outcome, side: Side) => unknown;
export interface Divergence {
  id: string;
  kind: string;
  reason: string;
  covers?: ((diff: Difference) => boolean) | undefined;
  coversResult?: boolean;
  assertUpstream(view: View, result: unknown): boolean;
  assertLocal(view: View, result: unknown): boolean;
}
export interface Step {
  op: string;
  now?: number | undefined;
  before?: ((context: ScenarioContext) => unknown) | undefined;
  upstream(oracle: Oracle, helpers: Helpers): unknown;
  local(local: Local, game: Game, helpers: Helpers): unknown;
  result?: Projection | undefined;
  expected?: Divergence[] | undefined;
}
export interface Scenario {
  name: string;
  covers?: string[];
  now?: number;
  setup?: (dump: Dump, helpers: Helpers) => void;
  steps: Step[];
}
export type TranslateModules = (modules: CodeModules) => CodeModules;
