/*
 * Pinned original backend running in-process against the pinned original storage.
 *
 * Nothing here re-implements backend or storage behaviour. The upstream pieces run unmodified:
 * - `@screeps/storage` `lib/index.js` socket listener, `lib/db.js` (LokiJS 1.5.6) and pubsub,
 *   served over a loopback TCP socket;
 * - `@screeps/common` `storage._connect()` RPC client (JSON framing, exactly as the backend uses it);
 * - `@screeps/backend` CLI modules, cron jobs, strongholds and express routers.
 *
 * Harness-only adaptations: the Loki persistence adapter is LokiJS's own in-memory adapter (no
 * autosave timer, no file), databases are (re)loaded through the upstream `loadDb()` (which runs
 * the upstream schema upgrade), storage-side code draws from a separate random stream (it is a
 * separate process upstream), and route handlers are invoked directly with the authenticated
 * user document instead of through HTTP/passport.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Controls, Document, Dump } from './types.ts';
import type {
  ApiOptions,
  Common,
  Handler,
  LokiConstructor,
  LokiDatabase,
  Notification,
  Oracle,
  Response,
  Router,
  RouterName,
  UpstreamModules,
} from './upstream.ts';
export type { Oracle } from './upstream.ts';

// Node's CommonJS hook is intentionally private: the oracle keeps original peer resolution.
const cjs = Module as typeof Module & {
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module | null | undefined,
    ...rest: unknown[]
  ) => string;
};

const DB_NAME = 'conformance.db';
const COMMON = '@screeps/common';

function strip(doc: Document): Document {
  const copy = JSON.parse(JSON.stringify(doc)) as Document;
  delete copy.meta;
  delete copy.$loki;
  return copy;
}

export async function createOracle({
  roots,
  controls,
  log,
}: {
  roots: Record<'backend' | 'common' | 'storage', string>;
  controls: Controls;
  log: (...args: unknown[]) => unknown;
}): Promise<Oracle> {
  // `@screeps/common` is a peer of backend and storage (installed by the launcher upstream).
  const originalResolve = cjs._resolveFilename;
  cjs._resolveFilename = function resolve(request, parent, ...rest) {
    if (request === COMMON || request.startsWith(`${COMMON}/`)) {
      request = join(roots.common, request.slice(COMMON.length));
    }
    return originalResolve.call(this, request, parent, ...rest);
  };

  const assetDir = mkdtempSync(join(tmpdir(), 'screeps-backend-conformance-'));
  mkdirSync(join(assetDir, 'map', 'zoom2'), { recursive: true });
  process.env.ASSET_DIR = assetDir;

  const backendRequire = createRequire(join(roots.backend, 'package.json'));
  const storageRequire = createRequire(join(roots.storage, 'package.json'));
  const common = backendRequire(COMMON) as Common;
  const config = common.configManager.config;

  // storage/lib/db.js arms a module-level expiry timer; keep it from holding the process open.
  const setIntervalOriginal = globalThis.setInterval;
  globalThis.setInterval = (...args: Parameters<typeof setInterval>) =>
    setIntervalOriginal(...args).unref();
  let databaseMethods: Record<string, (this: unknown, ...args: unknown[]) => unknown>;
  try {
    storageRequire('./lib/index.js');
    databaseMethods = storageRequire('./lib/db.js') as Record<
      string,
      (this: unknown, ...args: unknown[]) => unknown
    >;
  } finally {
    globalThis.setInterval = setIntervalOriginal;
  }
  const loki = storageRequire('lokijs') as LokiConstructor;

  let storageRequests = 0;
  for (const [name, fn] of Object.entries(databaseMethods)) {
    databaseMethods[name] = function storageMethod(this: unknown, ...args: unknown[]) {
      storageRequests++;
      return controls.inStorage(fn, this, args);
    };
  }

  let pendingJson: string;
  let current: LokiDatabase;
  config.storage.getDb = () => {
    const adapter = new loki.LokiMemoryAdapter();
    adapter.hashStore[DB_NAME] = { savecount: 1, lastsave: new Date(), value: pendingJson };
    current = new loki(DB_NAME, { adapter, autosave: false });
    return current;
  };

  const server = net.createServer(config.storage.socketListener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.STORAGE_HOST = '127.0.0.1';
  process.env.STORAGE_PORT = String((server.address() as AddressInfo).port);
  pendingJson = readFileSync(join(roots.storage, 'db.original.json'), 'utf8');
  await config.storage.loadDb();
  await common.storage._connect();

  // backend/lib/index.js and lib/game/server.js configuration the loaded modules read
  Object.assign(config, { backend: new EventEmitter(), cli: new EventEmitter() });
  Object.assign(config.backend, { customObjectTypes: {}, customIntentTypes: {} });
  const notifications: Notification[] = [];
  config.backend.on('sendUserNotifications', (user: Document, list: unknown[]) => {
    notifications.push({
      user: String(user._id),
      notifications: JSON.parse(JSON.stringify(list)) as unknown[],
    });
  });

  const lib = (path: string): unknown => backendRequire(`./lib/${path}`);
  const modules = {
    utils: lib('utils'),
    map: lib('cli/map'),
    bots: lib('cli/bots'),
    strongholdsCli: lib('cli/strongholds'),
    system: lib('cli/system'),
    strongholds: lib('strongholds'),
    cronjobs: lib('cronjobs'),
  } as UpstreamModules;
  const routers = {
    game: lib('game/api/game'),
    powerCreeps: lib('game/api/power-creeps'),
    market: lib('game/api/market'),
    user: lib('game/api/user'),
  } as Record<RouterName, Router>;
  const { db, env } = common.storage;

  /** Wait until every request issued so far (including un-awaited upstream chains) is served. */
  async function settle() {
    for (;;) {
      const before = storageRequests;
      await env.get(env.keys.GAMETIME);
      await new Promise((resolve) => setImmediate(resolve));
      if (storageRequests === before + 1) return;
    }
  }

  function dump(): Dump {
    const collections: Record<string, Document[]> = {};
    let envDocs: Dump['env'] = [];
    for (const collection of current.collections) {
      if (collection.name === 'env') envDocs = collection.data.map(strip) as Dump['env'];
      else collections[collection.name] = collection.data.map(strip);
    }
    return { collections, env: envDocs };
  }

  async function load(state: Dump) {
    const builder = new loki(DB_NAME, { adapter: new loki.LokiMemoryAdapter(), autosave: false });
    builder.addCollection('env').insert(state.env.map((doc) => structuredClone(doc)));
    for (const [name, docs] of Object.entries(state.collections)) {
      const collection = builder.addCollection(name);
      if (docs.length) collection.insert(docs.map((doc) => structuredClone(doc)));
    }
    pendingJson = builder.serialize();
    await config.storage.loadDb();
    notifications.length = 0;
  }

  function findHandler(router: Router, method: string, path: string): Handler {
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === path && layer.route.methods[method]) {
        const stack = layer.route.stack;
        const handler = stack[stack.length - 1];
        if (handler) return handler.handle;
      }
    }
    throw new Error(`upstream route ${method.toUpperCase()} ${path} not found`);
  }

  /** Call a route as `auth.tokenAuth` would after authenticating `userId`; resolves the JSON body. */
  async function api(
    routerName: RouterName,
    method: string,
    path: string,
    { userId, body = {}, query = {} }: ApiOptions = {},
  ) {
    const handler = findHandler(routers[routerName], method, path);
    const user = userId === undefined ? undefined : await db.users.findOne({ _id: userId });
    const response = await new Promise<unknown>((resolve, reject) => {
      const res: Response = {
        json: (data: unknown) => {
          resolve(JSON.parse(JSON.stringify(data)) as unknown);
        },
        status: () => res,
        send: (data: unknown) => {
          resolve(data);
        },
        set: () => res,
      };
      const request = {
        user,
        body: JSON.parse(JSON.stringify(body)) as Document,
        query: { ...query },
      };
      handler(request, res, (error) => {
        if (error) {
          reject(
            error instanceof Error
              ? error
              : new Error(typeof error === 'string' ? error : JSON.stringify(error)),
          );
        }
      });
    });
    await settle();
    return response;
  }

  return {
    common,
    config,
    C: config.common.constants,
    db,
    env,
    modules,
    notifications,
    initial: dump(),
    dump,
    load,
    settle,
    api,
    close() {
      cjs._resolveFilename = originalResolve;
      server.close();
      rmSync(assetDir, { recursive: true, force: true });
    },
    log,
  };
}
