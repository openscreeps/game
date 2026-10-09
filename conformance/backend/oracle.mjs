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

const DB_NAME = 'conformance.db';
const COMMON = '@screeps/common';

function strip(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.meta;
  delete copy.$loki;
  return copy;
}

export async function createOracle({ roots, controls, log }) {
  // `@screeps/common` is a peer of backend and storage (installed by the launcher upstream).
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolve(request, parent, ...rest) {
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
  const common = backendRequire(COMMON);
  const config = common.configManager.config;

  // storage/lib/db.js arms a module-level expiry timer; keep it from holding the process open.
  const setIntervalOriginal = globalThis.setInterval;
  globalThis.setInterval = (...args) => setIntervalOriginal(...args).unref();
  let storageIndex;
  let databaseMethods;
  try {
    storageIndex = storageRequire('./lib/index.js');
    databaseMethods = storageRequire('./lib/db.js');
  } finally {
    globalThis.setInterval = setIntervalOriginal;
  }
  void storageIndex;
  const loki = storageRequire('lokijs');

  let storageRequests = 0;
  for (const [name, fn] of Object.entries(databaseMethods)) {
    databaseMethods[name] = function storageMethod(...args) {
      storageRequests++;
      return controls.inStorage(fn, this, args);
    };
  }

  let pendingJson;
  let current;
  config.storage.getDb = () => {
    const adapter = new loki.LokiMemoryAdapter();
    adapter.hashStore[DB_NAME] = { savecount: 1, lastsave: new Date(), value: pendingJson };
    current = new loki(DB_NAME, { adapter, autosave: false });
    return current;
  };

  const server = net.createServer(config.storage.socketListener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.STORAGE_HOST = '127.0.0.1';
  process.env.STORAGE_PORT = String(server.address().port);
  pendingJson = readFileSync(join(roots.storage, 'db.original.json'), 'utf8');
  await config.storage.loadDb();
  await common.storage._connect();

  // backend/lib/index.js and lib/game/server.js configuration the loaded modules read
  Object.assign(config, { backend: new EventEmitter(), cli: new EventEmitter() });
  Object.assign(config.backend, { customObjectTypes: {}, customIntentTypes: {} });
  const notifications = [];
  config.backend.on('sendUserNotifications', (user, list) => {
    notifications.push({ user: String(user._id), notifications: JSON.parse(JSON.stringify(list)) });
  });

  const lib = (path) => backendRequire(`./lib/${path}`);
  const modules = {
    utils: lib('utils'),
    map: lib('cli/map'),
    bots: lib('cli/bots'),
    strongholdsCli: lib('cli/strongholds'),
    system: lib('cli/system'),
    strongholds: lib('strongholds'),
    cronjobs: lib('cronjobs'),
  };
  const routers = {
    game: lib('game/api/game'),
    powerCreeps: lib('game/api/power-creeps'),
    market: lib('game/api/market'),
    user: lib('game/api/user'),
  };
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

  function dump() {
    const collections = {};
    let envDocs = [];
    for (const collection of current.collections) {
      if (collection.name === 'env') envDocs = collection.data.map(strip);
      else collections[collection.name] = collection.data.map(strip);
    }
    return { collections, env: envDocs };
  }

  async function load(state) {
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

  function findHandler(router, method, path) {
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === path && layer.route.methods[method]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
    throw new Error(`upstream route ${method.toUpperCase()} ${path} not found`);
  }

  /** Call a route as `auth.tokenAuth` would after authenticating `userId`; resolves the JSON body. */
  async function api(routerName, method, path, { userId, body = {}, query = {} } = {}) {
    const handler = findHandler(routers[routerName], method, path);
    const user = userId === undefined ? undefined : await db.users.findOne({ _id: userId });
    const response = await new Promise((resolve, reject) => {
      const res = {
        json: (data) => resolve(JSON.parse(JSON.stringify(data))),
        status: () => res,
        send: (data) => resolve(data),
        set: () => res,
      };
      const request = { user, body: JSON.parse(JSON.stringify(body)), query: { ...query } };
      handler(request, res, (error) => {
        if (error) reject(error);
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
      Module._resolveFilename = originalResolve;
      server.close();
      rmSync(assetDir, { recursive: true, force: true });
    },
    log,
  };
}
