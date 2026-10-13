import type { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type {
  CodeModules,
  Constants,
  GenerateRoomOptions,
  SpawnBotOptions,
  SpawnStrongholdOptions,
} from '../../src/index.ts';
import type { Document, Dump } from './types.ts';

/** Shapes consumed from the pinned, untyped CommonJS packages; no rule logic lives here. */
export interface DatabaseCollection {
  find(query: Document): Promise<Document[]>;
  findOne(query: Document): Promise<Document | null>;
  removeWhere(query: Document): Promise<unknown>;
}
/** These collections are created by the pinned storage schema upgrade. */
export interface Database extends Record<string, DatabaseCollection> {
  users: DatabaseCollection;
  rooms: DatabaseCollection;
  'rooms.objects': DatabaseCollection;
  'users.power_creeps': DatabaseCollection;
}
export interface StorageEnv {
  keys: { GAMETIME: string; ACTIVE_ROOMS: string; ACCESSIBLE_ROOMS: string };
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
}
export interface LokiCollection {
  name: string;
  data: Document[];
  insert(docs: object[]): unknown;
}
export interface LokiDatabase {
  collections: LokiCollection[];
  addCollection(name: string): LokiCollection;
  serialize(): string;
}
export interface LokiAdapter {
  hashStore: Record<string, { savecount: number; lastsave: Date; value: string }>;
}
export interface LokiConstructor {
  new (name: string, options: { adapter: LokiAdapter; autosave: boolean }): LokiDatabase;
  LokiMemoryAdapter: new () => LokiAdapter;
}
export interface Config {
  common: { constants: Constants; bots: Record<string, string> };
  storage: {
    getDb(): LokiDatabase;
    loadDb(): Promise<unknown>;
    socketListener: (socket: Socket) => void;
  };
  backend: EventEmitter & {
    customObjectTypes?: Record<string, unknown>;
    customIntentTypes?: Record<string, unknown>;
  };
  cli: EventEmitter;
}
export interface Common {
  configManager: { config: Config };
  storage: {
    db: Database;
    env: StorageEnv;
    _connect(): Promise<unknown>;
  };
}
export interface UpstreamModules {
  utils: {
    translateModulesFromDb(modules: CodeModules): CodeModules;
    respawnUser(user: string): Promise<unknown>;
  };
  map: {
    generateRoom(room: string, options: GenerateRoomOptions): Promise<unknown>;
    openRoom(room: string, timestamp?: number): Promise<unknown>;
    closeRoom(room: string): Promise<unknown>;
    removeRoom(room: string): Promise<unknown>;
    updateRoomImageAssets(room: string): Promise<unknown>;
    updateTerrainData(): Promise<unknown>;
  };
  bots: {
    spawn(bot: string, room: string, options?: SpawnBotOptions): Promise<unknown>;
    reload(bot: string): Promise<unknown>;
    removeUser(username: string): Promise<unknown>;
  };
  strongholdsCli: {
    spawn(room: string, options?: SpawnStrongholdOptions): Promise<unknown>;
    expand(room: string): Promise<unknown>;
  };
  system: { runCronjob(name: string): Promise<unknown> };
  strongholds: unknown;
  cronjobs: unknown;
}
export type RouterName = 'game' | 'powerCreeps' | 'market' | 'user';
export interface ApiOptions {
  userId?: string | undefined;
  body?: Document | undefined;
  query?: Document | undefined;
}
export interface Response {
  json(data: unknown): void;
  status(): Response;
  send(data: unknown): void;
  set(): Response;
}
export type Handler = (
  request: { user: Document | null | undefined; body: Document; query: Document },
  response: Response,
  next: (error?: unknown) => void,
) => unknown;
export interface Router {
  stack: {
    route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
  }[];
}
export interface Notification {
  user: string;
  notifications: unknown[];
}
export interface Oracle {
  common: Common;
  config: Config;
  C: Constants;
  db: Database;
  env: StorageEnv;
  modules: UpstreamModules;
  notifications: Notification[];
  initial: Dump;
  dump(): Dump;
  load(state: Dump): Promise<void>;
  settle(): Promise<void>;
  api(router: RouterName, method: string, path: string, options?: ApiOptions): Promise<unknown>;
  close(): void;
  log(...args: unknown[]): unknown;
}
