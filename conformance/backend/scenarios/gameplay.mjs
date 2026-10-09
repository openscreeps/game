/*
 * Gameplay validation and state mutation: backend `lib/game/api/*.js` route handlers against
 * `game/src/domain/*` and `game/src/code.ts`.
 *
 * Local calls receive the request decoded the way the server host decodes it (`parseInt` for
 * `parseInt`ed coordinates, strings/numbers by type) and return the route's response body, so both
 * sides are compared on the same wire-level values.
 */

import { route } from './api.mjs';

const EMMA = '17c332744f825c7'; // EmmaBot, owns W1N1 (RCL 1) in the original default world
const MICHAEL = 'a1123272b261687'; // MichaelBot, owns W9N9
const ALICE = 'e3b732c504eb83a'; // AliceBot, owns W1N9
const EMMA_SPAWN = '333232744fc1cee';
const EMMA_CONTROLLER = '855c077511105bf';
const MICHAEL_SPAWN = '092c3272b2c03f7';
const W2N2_CONTROLLER = '21ee0774a5bbeb0';
const W3N3_CONTROLLER = '292807742d07fd0';
const W2N1_CONTROLLER = 'cccc0774ad79184';
const W5N5_EXTRACTOR = 'a9de61653eb4afd';

/* Fixture users inserted by `setup` (ids in the storage's 15 hex digit format). */
const NEWBIE = 'b00000000000001';
const NEWBIE2 = 'b00000000000002';
const BLOCKED = 'b00000000000003';
const NO_CPU = 'b00000000000004';
const RESPAWNED = 'b00000000000005';
const NAMELESS = 'b00000000000006';
const POWER_USER = 'b00000000000007';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Room entry fields backend game.js `/map-stats` can produce. */
const MAP_STATS_FIELDS = [
  'status',
  'novice',
  'respawnArea',
  'openTime',
  'own',
  'sign',
  'safeMode',
  'minerals0',
];

/* ---------------------------------------------------------------- fixtures (raw storage docs) */

function user(_id, username, fields = {}) {
  return {
    _id,
    username,
    usernameLower: username.toLowerCase(),
    cpu: 100,
    gcl: 0,
    cpuAvailable: 0,
    active: 0,
    badge: {
      type: 1,
      color1: '#000000',
      color2: '#111111',
      color3: '#222222',
      param: 0,
      flip: false,
    },
    ...fields,
  };
}

function addDocs(dump, collection, docs) {
  (dump.collections[collection] ??= []).push(...docs.map((doc) => structuredClone(doc)));
}

function patch(dump, collection, id, fields) {
  const doc = dump.collections[collection].find((d) => d._id === id);
  if (!doc) throw new Error(`fixture: no ${collection} ${id}`);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete doc[key];
    else doc[key] = value;
  }
}

/* ---------------------------------------------------------------- request decoding (host side) */

const str = (value) => (typeof value === 'string' ? value : undefined);
const num = (value) => (typeof value === 'number' ? value : undefined);
function int(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  if (typeof value === 'string') return Number.parseInt(value, 10);
  return Number.NaN;
}

/** Storage bookkeeping the original RPC returns with every document. */
function doc(value) {
  if (!value || typeof value !== 'object') return value;
  const { meta, $loki, ...rest } = value;
  void meta;
  void $loki;
  return rest;
}

/** Drop the (storage- vs. game-generated) `_id` of a document created by the step. */
function created(value) {
  const { _id, ...rest } = doc(value);
  return { ...rest, _id: typeof _id === 'string' ? 'new id' : _id };
}

const body = (keys) => (data) => Object.fromEntries(keys.map((key) => [key, data[key] ?? null]));

/* ---------------------------------------------------------------- route steps */

const game = (method, path, options) => route('game', method, path, options);
const power = (method, path, options) => route('powerCreeps', method, path, options);
const market = (method, path, options) => route('market', method, path, options);
const userRoute = (method, path, options) => route('user', method, path, options);

function createFlag(userId, input) {
  return game('post', '/create-flag', {
    user: userId,
    body: input,
    local: (l, g) =>
      g.createFlag(l.context, userId, {
        room: str(input.room),
        x: num(input.x),
        y: num(input.y),
        name: str(input.name),
        color: num(input.color),
        secondaryColor: num(input.secondaryColor),
      }),
  });
}

function genFlagName(userId) {
  return game('post', '/gen-unique-flag-name', {
    user: userId,
    local: (l, g) => ({ name: g.uniqueFlagName(l.state.world, userId) }),
    result: apiBody(body(['name'])),
  });
}

function checkFlagName(userId, name) {
  return game('post', '/check-unique-flag-name', {
    user: userId,
    body: { name },
    local: (l, g) => g.checkUniqueFlagName(l.state.world, userId, str(name)),
  });
}

function changeFlagColor(userId, input) {
  return game('post', '/change-flag-color', {
    user: userId,
    body: input,
    local: (l, g) =>
      g.changeFlagColor(l.state, userId, {
        room: str(input.room),
        name: str(input.name),
        color: num(input.color),
        secondaryColor: num(input.secondaryColor),
      }),
  });
}

function removeFlag(userId, input) {
  return game('post', '/remove-flag', {
    user: userId,
    body: input,
    local: (l, g) =>
      g.removeFlag(l.state, userId, { room: str(input.room), name: str(input.name) }),
  });
}

function construct(userId, input, options = {}) {
  return game('post', '/create-construction', {
    user: userId,
    body: input,
    ...options,
    local: (l, g) => {
      const name = input.name;
      if (name && typeof name !== 'string') throw new g.GameError('invalid params');
      return g.createConstructionSite(l.context, userId, {
        room: str(input.room),
        x: int(input.x),
        y: int(input.y),
        structureType: str(input.structureType),
        name: typeof name === 'string' && name ? name : undefined,
      });
    },
    result: apiBody((data) => ({ created: typeof data._id === 'string' })),
  });
}

function placeSpawn(userId, input) {
  return game('post', '/place-spawn', {
    user: userId,
    body: input,
    local: (l, g) => {
      g.placeSpawn(l.context, userId, {
        room: str(input.room),
        x: int(input.x),
        y: int(input.y),
        name: str(input.name),
      });
      return { newbie: true };
    },
    result: apiBody(body(['newbie'])),
  });
}

function objectIntent(userId, input, options = {}) {
  return game('post', '/add-object-intent', {
    user: userId,
    body: input,
    ...options,
    local: (l, g) =>
      g.addObjectIntent(l.context, userId, {
        room: str(input.room),
        targetId: str(input._id),
        name: str(input.name),
        intent: input.intent,
      }),
  });
}

function globalIntent(userId, input) {
  return game('post', '/add-global-intent', {
    user: userId,
    body: input,
    local: (l, g) =>
      g.addGlobalIntent(l.state, userId, { name: str(input.name), intent: input.intent }),
  });
}

/** `apiResult` with a projection applied to both sides' response bodies. */
function apiBody(project) {
  return (outcome, side) => {
    if (side === 'upstream') {
      if (!outcome.ok) return { error: `harness: ${outcome.error}` };
      const { ok, error, ...data } = outcome.value ?? {};
      void ok;
      if (error !== undefined) return { error };
      return { ok: project(data, side) ?? null };
    }
    if (!outcome.ok) return { error: outcome.error };
    return { ok: project(outcome.value ?? {}, side) ?? null };
  };
}

function invader(input) {
  return game('post', '/create-invader', {
    user: EMMA,
    body: input,
    local: (l, g) =>
      g.createInvader(l.context, EMMA, {
        room: str(input.room),
        x: int(input.x),
        y: int(input.y),
        size: str(input.size),
        type: str(input.type),
        boosted: !!input.boosted,
      }),
    result: apiBody(created),
  });
}

/* ---------------------------------------------------------------- named expected divergences */

/** A narrow divergence whose assertions must hold on both sides' actual outputs. */
function divergence(id, kind, reason, { covers, coversResult = false, upstream, local }) {
  return {
    id,
    kind,
    reason,
    covers,
    coversResult,
    assertUpstream: (view, result) => upstream(view, result) === true,
    assertLocal: (view, result) => local(view, result) === true,
  };
}

const queuedIntents = (view, room, userId) =>
  view.collections['rooms.intents']?.find((d) => d.room === room)?.users?.[userId]?.objectsManual;

/** `targets`: `[target, room, ...]` of every foreign intent queued upstream so far. */
function foreignIntent(targets, { target, room, error }) {
  return divergence(
    'GP-D1 manual-intent-ownership',
    'safety',
    "backend game.js:507-528 queues `objectsManual` for any object id the request names; the local game only queues intents for objects in that room the player owns (or, unowned, whose room controller it owns): the processor skips other players' objects but runs intents of unowned objects, e.g. `send` from an NPC terminal (engine processor.js object loop, `object.user && object.user != userId`).",
    {
      coversResult: true,
      covers: (diff) =>
        diff.collection === 'rooms.intents' &&
        targets.some(
          ([id, targetRoom]) =>
            diff.key === targetRoom &&
            (String(diff.path ?? '').includes(`.objectsManual.${id}`) ||
              (!diff.path && JSON.stringify(diff.upstream ?? null).includes(`"${id}"`))),
        ),
      upstream: (view, result) =>
        result.ok === null && queuedIntents(view, room, EMMA)?.[target] !== undefined,
      local: (view, result) =>
        result.error === error && queuedIntents(view, room, EMMA)?.[target] === undefined,
    },
  );
}

function malformedIntent(target, name) {
  return divergence(
    'GP-D2 manual-intent-shape',
    'safety',
    'common system.js:95-114 sanitizes a list for an object intent and a single object for a room-level list intent, and game.js:507-528 stores them; the processors then throw for the whole room (`intent.body.slice` in spawns/create-creep, `intents.destroyStructure.forEach` in room/intents), and room-level list entries create flags/sites in `intent.roomName`, escaping the queued room. The local game refuses these shapes (`invalid params`).',
    {
      coversResult: true,
      covers: (diff) => diff.collection === 'rooms.intents' && diff.key === 'W1N1',
      upstream: (view, result) =>
        result.ok === null && queuedIntents(view, 'W1N1', EMMA)?.[target]?.[name] !== undefined,
      local: (view, result) =>
        result.error === 'invalid params' && queuedIntents(view, 'W1N1', EMMA) === undefined,
    },
  );
}

function invaderCoordinates() {
  return divergence(
    'GP-D3 invader-coordinates',
    'safety',
    'backend game.js:665-666 stores the request\'s `x`/`y` unparsed (`"13"`); the local game stores room tile integers (the host parses them), since string or out-of-room positions break the processor\'s movement and range arithmetic for every player in the room.',
    {
      // the step compares its result without `x`/`y`; the stored creep's position is asserted here
      covers: (diff) =>
        diff.collection === 'rooms.objects' && (diff.path === '.x' || diff.path === '.y'),
      upstream: (view, result) =>
        result.ok !== undefined &&
        view.collections['rooms.objects'].some(
          (o) => o.userSummoned === EMMA && o.x === '13' && o.y === '10',
        ),
      local: (view, result) =>
        result.ok !== undefined &&
        view.collections['rooms.objects'].some(
          (o) => o.userSummoned === EMMA && o.x === 13 && o.y === 10,
        ),
    },
  );
}

function fractionalPowerLevel(id) {
  const creep = (view) => view.collections['users.power_creeps'].find((c) => c._id === id);
  return divergence(
    'GP-D4 power-level-integer',
    'safety',
    "backend power-creeps.js:154 only checks `_.isNumber`, so `{1: 0.5}` stores power level 0.5 / creep level 0.5; the local game requires whole levels (`invalid value for power`) because the processors index power effects by level and a fractional level yields undefined effects applied to other players' objects.",
    {
      coversResult: true,
      covers: (diff) => diff.collection === 'users.power_creeps' && diff.key === id,
      upstream: (view, result) =>
        result.ok === null && creep(view)?.level === 0.5 && creep(view)?.powers?.[1]?.level === 0.5,
      local: (view, result) =>
        result.error === 'invalid value for power 1' &&
        creep(view)?.level === 0 &&
        JSON.stringify(creep(view)?.powers) === '{}',
    },
  );
}

function experimentationDelete(name) {
  const exists = (view) =>
    view.collections['users.power_creeps'].some((c) => c.name === name && c.user === POWER_USER);
  return divergence(
    'GP-D5 power-experimentation-delete',
    'upstream-crash',
    "backend power-creeps.js:80 calls `db['users.power_creeps'].remove`, which the storage client does not provide: deleting during power experimentation fails with a TypeError and keeps the creep. The local game completes the intended immediate deletion.",
    {
      coversResult: true,
      covers: (diff) => diff.collection === 'users.power_creeps' && diff.upstream?.name === name,
      upstream: (view, result) => String(result.error).startsWith('TypeError:') && exists(view),
      local: (view, result) => result.ok === null && !exists(view),
    },
  );
}

function mapStatRankings(statName) {
  return divergence(
    'GP-D6 map-stats-rankings',
    'upstream-todo',
    'backend game.js:217-242 parses the requested stat name but never computes it (`statsMax = {}`); the local game ranks the stat per room from its recorded statistics and reports `statsMax[statName]`.',
    {
      coversResult: true,
      upstream: (view, result) => JSON.stringify(result.ok?.statsMax) === '{}',
      // only the ranking may differ: every room entry carries upstream's fields or the stat list
      local: (view, result) =>
        Object.keys(result.ok?.statsMax ?? {}).join() === statName &&
        typeof result.ok.statsMax[statName] === 'number' &&
        Object.values(result.ok.stats).every((entry) =>
          Object.keys(entry).every((key) => MAP_STATS_FIELDS.includes(key) || key === statName),
        ),
    },
  );
}

function roomOverviewStats(ownerName) {
  const owner = (result) => (result.ok?.owner ?? null)?.username ?? null;
  return divergence(
    'GP-D7 room-overview-stats',
    'upstream-todo',
    "backend game.js:583-601 is marked `// TODO` and answers `stats: {}, statsMax: {}, totals: {}`; the local game returns the room's recorded stat series and totals (same owner).",
    {
      coversResult: true,
      upstream: (view, result) =>
        owner(result) === ownerName &&
        ['stats', 'statsMax', 'totals'].every((key) => JSON.stringify(result.ok[key]) === '{}'),
      local: (view, result) =>
        owner(result) === ownerName &&
        Object.values(result.ok?.stats ?? {}).length > 0 &&
        Object.values(result.ok.stats).every(Array.isArray),
    },
  );
}

/** Fixture market orders as the route lists them (price in credits). */
const MARKET_ORDERS = [
  {
    _id: 'o00000000000001',
    created: 10,
    createdTimestamp: NOW - 1000,
    active: true,
    type: 'sell',
    amount: 100,
    remainingAmount: 100,
    totalAmount: 100,
    resourceType: 'energy',
    price: 1500,
    user: EMMA,
    roomName: 'W1N1',
  },
  {
    _id: 'o00000000000002',
    created: 11,
    active: true,
    type: 'buy',
    amount: 50,
    remainingAmount: 50,
    totalAmount: 50,
    resourceType: 'energy',
    price: 1200,
    user: MICHAEL,
    roomName: 'W9N9',
  },
  {
    _id: 'o00000000000003',
    created: 12,
    active: false,
    type: 'sell',
    amount: 0,
    remainingAmount: 0,
    totalAmount: 10,
    resourceType: 'energy',
    price: 2000,
    user: EMMA,
    roomName: 'W1N1',
  },
  {
    _id: 'o00000000000004',
    created: 13,
    active: true,
    type: 'sell',
    amount: 5,
    remainingAmount: 5,
    totalAmount: 5,
    resourceType: 'H',
    price: 333,
    user: MICHAEL,
    roomName: 'W9N9',
  },
  {
    _id: 'o00000000000005',
    created: 14,
    active: true,
    type: 'sell',
    amount: 5,
    remainingAmount: 5,
    totalAmount: 5,
    resourceType: 'H',
    price: 1,
    roomName: 'W5N5',
  },
];

/* ---------------------------------------------------------------- scenarios */

const flagsAt = (count, room) =>
  Array.from(
    { length: count },
    (_, i) =>
      `F${String(i)}~1~1~${String(10 + (i % 30))}~${String(10 + (Math.floor(i / 30) % 30))}`,
  ).join('|');

const mapStatsStep = (rooms, statName, userId = EMMA) =>
  game('post', '/map-stats', {
    user: userId,
    body: { rooms, statName },
    local: (l, g) => {
      const { userIds, ...stats } = g.mapStats(l.state, l.context.now(), { rooms, statName });
      return {
        ...stats,
        users: Object.fromEntries(
          [...userIds].filter((id) => l.state.world.users[id]).map((id) => [id, true]),
        ),
      };
    },
    result: apiBody((data) => ({
      gameTime: data.gameTime,
      stats: data.stats,
      statsMax: data.statsMax,
      users: Object.keys(data.users ?? {}).sort(),
    })),
  });

export default [
  {
    name: 'gameplay.flags.basic',
    covers: ['POST /game/create-flag'],
    steps: [
      route('game', 'post', '/create-flag', {
        user: EMMA,
        body: { room: 'W1N1', x: 10, y: 10, name: 'Flag1', color: 1, secondaryColor: 2 },
        local: (l, game) =>
          game.createFlag(l.context, EMMA, {
            room: 'W1N1',
            x: 10,
            y: 10,
            name: 'Flag1',
            color: 1,
            secondaryColor: 2,
          }),
      }),
    ],
  },

  /* ------------------------------------------------------------ map */
  {
    name: 'gameplay.map.stats',
    covers: ['POST /game/map-stats'],
    setup(dump) {
      patch(dump, 'rooms', 'W2N2', {
        novice: NOW + 86400000,
        respawnArea: NOW + 3600000,
        openTime: NOW - 1000,
      });
      patch(dump, 'rooms.objects', W2N2_CONTROLLER, {
        reservation: { user: ALICE, endTime: 3000 },
        sign: { user: MICHAEL, text: 'hello', time: 1, datetime: NOW },
      });
      patch(dump, 'rooms.objects', W3N3_CONTROLLER, {
        hardSign: { text: 'novice area', time: 1, datetime: NOW, endDatetime: NOW + 1 },
        isPowerEnabled: true,
        safeMode: 5000,
      });
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000001',
          type: 'invaderCore',
          room: 'W2N1',
          x: 25,
          y: 25,
          level: 2,
          user: '2',
          hits: 1000,
          hitsMax: 1000,
        },
      ]);
    },
    steps: [
      mapStatsStep(['W1N1', 'W2N2', 'W3N3', 'W5N5', 'W9N9', 'W2N1', 'W99N99'], 'owner0'),
      {
        ...mapStatsStep(['W3N3', 'W1N1'], 'energyHarvested8'),
        expected: [mapStatRankings('energyHarvested8')],
      },
      mapStatsStep(['W1N1'], 'claim'),
      mapStatsStep([], 'minerals0'),
    ],
  },
  {
    name: 'gameplay.map.terrain',
    covers: ['GET /game/room-terrain'],
    steps: [
      game('get', '/room-terrain', {
        query: { room: 'W1N1' },
        local: (l, g) => ({
          terrain: g.terrainTiles('W1N1', g.roomTerrain(l.state.world, 'W1N1')),
        }),
        result: apiBody(body(['terrain'])),
      }),
      game('get', '/room-terrain', {
        query: { room: 'W2N2', encoded: '1' },
        local: (l, g) => ({
          terrain: [
            { room: 'W2N2', terrain: g.roomTerrain(l.state.world, 'W2N2'), type: 'terrain' },
          ],
        }),
        result: apiBody((data) => ({
          terrain: data.terrain.map((t) => ({ room: t.room, terrain: t.terrain, type: t.type })),
        })),
      }),
      game('get', '/room-terrain', {
        query: { room: 'W40N40' },
        local: (l, g) => ({
          terrain: g.terrainTiles('W40N40', g.roomTerrain(l.state.world, 'W40N40')),
        }),
      }),
    ],
  },
  {
    name: 'gameplay.map.room-status',
    covers: ['GET /game/room-status'],
    setup(dump) {
      patch(dump, 'rooms', 'W2N2', {
        novice: NOW + 86400000,
        respawnArea: NOW + 3600000,
        openTime: NOW - 1000,
      });
      patch(dump, 'rooms', 'W3N3', { status: 'out of borders' });
    },
    steps: ['W1N1', 'W2N2', 'W3N3', 'W40N40'].map((room) =>
      game('get', '/room-status', {
        user: EMMA,
        query: { room },
        local: (l, g) => ({ room: g.roomStatus(l.state.world, room) }),
        result: apiBody(body(['room'])),
      }),
    ),
  },
  {
    name: 'gameplay.map.world-size',
    covers: ['GET /game/world-size'],
    steps: [
      game('get', '/world-size', {
        local: (l, g) => {
          const size = g.worldSize(l.state.world);
          return { width: size, height: size };
        },
        result: apiBody(body(['width', 'height'])),
      }),
    ],
  },
  {
    name: 'gameplay.map.room-overview',
    covers: ['GET /game/room-overview'],
    steps: ['W1N1', 'W2N2', 'W40N40'].map((room) =>
      game('get', '/room-overview', {
        user: MICHAEL,
        query: { room },
        local: (l, g) => {
          const { ownerId, ...stats } = g.roomOverview(l.state, l.context.now(), {
            room,
            interval: undefined,
          });
          const owner = ownerId ? l.state.world.users[ownerId] : undefined;
          return {
            owner: owner ? { username: owner.username, badge: owner.badge } : null,
            ...stats,
          };
        },
        result: apiBody(body(['owner', 'stats', 'statsMax', 'totals'])),
        expected: [roomOverviewStats(room === 'W1N1' ? 'EmmaBot' : null)],
      }),
    ),
  },

  /* ------------------------------------------------------------ object names, place-spawn */
  {
    name: 'gameplay.spawn.names',
    covers: ['POST /game/gen-unique-object-name', 'POST /game/check-unique-object-name'],
    setup(dump) {
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000002',
          type: 'constructionSite',
          room: 'W1N1',
          x: 20,
          y: 20,
          structureType: 'spawn',
          name: 'Spawn2',
          user: EMMA,
          progress: 0,
          progressTotal: 15000,
        },
        {
          _id: 'c00000000000003',
          type: 'constructionSite',
          room: 'W1N1',
          x: 21,
          y: 20,
          structureType: 'road',
          name: 'Spawn3',
          user: EMMA,
          progress: 0,
          progressTotal: 300,
        },
      ]);
    },
    steps: [
      ...[EMMA, MICHAEL].map((userId) =>
        game('post', '/gen-unique-object-name', {
          user: userId,
          body: { type: 'spawn' },
          local: (l, g) => ({ name: g.uniqueObjectName(l.state.world, userId, 'spawn') }),
          result: apiBody(body(['name'])),
        }),
      ),
      game('post', '/gen-unique-object-name', {
        user: EMMA,
        body: { type: 'extension' },
        local: (l, g) => ({ name: g.uniqueObjectName(l.state.world, EMMA, 'extension') }),
        result: apiBody(body(['name'])),
      }),
      ...[
        { type: 'spawn', name: 'Spawn1' },
        { type: 'spawn', name: 'Spawn2' },
        { type: 'spawn', name: 'Spawn3' },
        { type: 'spawn', name: 'Spawn4' },
        { type: 'extension', name: 'Spawn4' },
        { type: 'spawn', name: 5 },
      ].map((input) =>
        game('post', '/check-unique-object-name', {
          user: EMMA,
          body: input,
          local: (l, g) =>
            g.checkUniqueObjectName(l.state.world, EMMA, {
              type: str(input.type),
              name: str(input.name),
            }),
        }),
      ),
    ],
  },
  {
    name: 'gameplay.spawn.place',
    covers: ['POST /game/place-spawn'],
    setup(dump) {
      addDocs(dump, 'users', [
        user(NEWBIE, 'Newbie'),
        user(BLOCKED, 'Blocked', { blocked: true }),
        user(NO_CPU, 'NoCpu', { cpu: 0 }),
        user(RESPAWNED, 'Respawned', { lastRespawnDate: NOW - 60000 }),
        user(NAMELESS, 'Nameless', { lastRespawnDate: NOW - 180000 }),
      ]);
      patch(dump, 'rooms', 'W3N2', { status: 'out of borders' });
      patch(dump, 'rooms', 'W4N4', { openTime: NOW + 60000 });
      patch(dump, 'rooms.objects', W2N1_CONTROLLER, {
        reservation: { user: MICHAEL, endTime: 5000 },
      });
    },
    steps: [
      placeSpawn(NEWBIE, { room: 'W2N2', x: 50, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N2', x: 10, y: -1, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N2', x: 10, y: 10, name: 'x'.repeat(51) }),
      placeSpawn(BLOCKED, { room: 'W2N2', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NO_CPU, { room: 'W2N2', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(RESPAWNED, { room: 'W2N2', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W40N40', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W3N2', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W4N4', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W1N1', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N1', x: 20, y: 20, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W5N5', x: 20, y: 20, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N2', x: 0, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N2', x: 16, y: 10, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N2', x: 4, y: 21, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W2N2', x: '10', y: 10.7, name: 'Spawn1' }),
      placeSpawn(NEWBIE, { room: 'W7N7', x: 10, y: 10, name: 'Spawn1' }),
      placeSpawn(NAMELESS, { room: 'W7N7', x: 10, y: 10 }),
    ],
  },
  {
    name: 'gameplay.spawn.place-over-others',
    covers: ['POST /game/place-spawn'],
    setup(dump) {
      addDocs(dump, 'users', [user(NEWBIE, 'Newbie'), user(NEWBIE2, 'Newbie2')]);
      patch(dump, 'rooms.objects', W3N3_CONTROLLER, { bindUser: NEWBIE2 });
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000010',
          type: 'creep',
          room: 'W3N3',
          x: 20,
          y: 20,
          user: MICHAEL,
          name: 'm1',
          body: [{ type: 'move', hits: 100 }],
          hits: 100,
          hitsMax: 100,
          store: {},
          storeCapacity: 0,
          ticksToLive: 100,
          fatigue: 0,
        },
        {
          _id: 'c00000000000011',
          type: 'constructionSite',
          room: 'W3N3',
          x: 21,
          y: 20,
          user: MICHAEL,
          structureType: 'road',
          progress: 0,
          progressTotal: 300,
        },
        {
          _id: 'c00000000000012',
          type: 'extension',
          room: 'W3N3',
          x: 22,
          y: 20,
          user: MICHAEL,
          store: { energy: 40 },
          storeCapacityResource: { energy: 50 },
          hits: 1000,
          hitsMax: 1000,
        },
        {
          _id: 'c00000000000013',
          type: 'road',
          room: 'W3N3',
          x: 23,
          y: 20,
          user: MICHAEL,
          hits: 5000,
          hitsMax: 5000,
        },
        {
          _id: 'c00000000000014',
          type: 'road',
          room: 'W3N3',
          x: 24,
          y: 20,
          hits: 5000,
          hitsMax: 5000,
        },
        {
          _id: 'c00000000000015',
          type: 'tombstone',
          room: 'W3N3',
          x: 25,
          y: 20,
          user: MICHAEL,
          store: {},
        },
      ]);
    },
    steps: [
      placeSpawn(NEWBIE, { room: 'W3N3', x: 10, y: 20, name: 'Spawn1' }),
      placeSpawn(NEWBIE2, { room: 'W3N3', x: 30, y: 25, name: 'First' }),
    ],
  },

  /* ------------------------------------------------------------ flags */
  {
    name: 'gameplay.flags.lifecycle',
    covers: [
      'POST /game/create-flag',
      'POST /game/gen-unique-flag-name',
      'POST /game/check-unique-flag-name',
      'POST /game/change-flag-color',
      'POST /game/remove-flag',
    ],
    steps: [
      genFlagName(EMMA),
      createFlag(EMMA, { room: 'W1N1', x: 10, y: 10, name: 'Flag1', color: 1, secondaryColor: 2 }),
      createFlag(EMMA, { room: 'W1N1', x: 11, y: 12, name: 'Flag2', color: 3, secondaryColor: 3 }),
      genFlagName(EMMA),
      genFlagName(MICHAEL),
      checkFlagName(EMMA, 'Flag1'),
      checkFlagName(EMMA, 'Flag9'),
      checkFlagName(MICHAEL, 'Flag1'),
      // moving a flag within the room re-appends it
      createFlag(EMMA, { room: 'W1N1', x: 30, y: 30, name: 'Flag1', color: 5, secondaryColor: 5 }),
      // moving the room's only flags away leaves an empty room document behind
      createFlag(EMMA, { room: 'W2N2', x: 5, y: 6, name: 'Flag1', color: 2, secondaryColor: 2 }),
      createFlag(EMMA, { room: 'W2N2', x: 7, y: 8, name: 'Flag2', color: 2, secondaryColor: 2 }),
      genFlagName(EMMA),
      createFlag(EMMA, { room: 'W1N1', x: 0, y: 49, name: 'Flag3', color: 10, secondaryColor: 1 }),
      changeFlagColor(EMMA, { room: 'W2N2', name: 'Flag2', color: 7, secondaryColor: 8 }),
      changeFlagColor(EMMA, { room: 'W2N2', name: 'Flag2', color: 11, secondaryColor: 8 }),
      changeFlagColor(EMMA, { room: 'W2N2', name: 'Flag2', color: 7, secondaryColor: 0 }),
      changeFlagColor(EMMA, { room: 'W2N2', name: 'Missing', color: 4, secondaryColor: 4 }),
      changeFlagColor(EMMA, { room: 'W5N5', name: 'Flag2', color: 4, secondaryColor: 4 }),
      changeFlagColor(EMMA, { name: 'Flag2', color: 4, secondaryColor: 4 }),
      removeFlag(EMMA, { room: 'W2N2', name: 'Missing' }),
      removeFlag(EMMA, { room: 'W7N7', name: 'Flag1' }),
      removeFlag(EMMA, { name: 'Flag1' }),
      removeFlag(EMMA, { room: 'W2N2', name: 'Flag1' }),
      removeFlag(EMMA, { room: 'W2N2', name: 'Flag2' }),
      removeFlag(MICHAEL, { room: 'W1N1', name: 'Flag3' }),
      genFlagName(EMMA),
    ],
  },
  {
    name: 'gameplay.flags.validation',
    covers: ['POST /game/create-flag'],
    setup(dump) {
      patch(dump, 'rooms', 'W3N3', { status: 'out of borders' });
      patch(dump, 'rooms', 'W4N4', { openTime: NOW + 60000 });
    },
    steps: [
      createFlag(EMMA, { room: 'W1N1', x: 50, y: 10, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: 10, y: -1, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: '10', y: 10, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, {
        room: 'W1N1',
        x: 10,
        y: 10,
        name: 'x'.repeat(61),
        color: 1,
        secondaryColor: 1,
      }),
      createFlag(EMMA, { room: 'W1N1', x: 10, y: 10, name: 7, color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: 10, y: 10, name: 'A', color: 0, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: 10, y: 10, name: 'A', color: 1, secondaryColor: '1' }),
      createFlag(EMMA, { room: 'W40N40', x: 10, y: 10, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W3N3', x: 10, y: 10, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W4N4', x: 10, y: 10, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { x: 10, y: 10, name: 'A', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, {
        room: 'W1N1',
        x: 10,
        y: 10,
        name: 'x'.repeat(60),
        color: 1,
        secondaryColor: 1,
      }),
      createFlag(EMMA, { room: 'W1N1', x: 12.5, y: 0, name: 'half', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: 3, y: 4, name: '', color: 1, secondaryColor: 1 }),
      genFlagName(EMMA),
      checkFlagName(EMMA, ''),
      checkFlagName(EMMA, undefined),
    ],
  },
  {
    name: 'gameplay.flags.duplicate-docs',
    covers: ['POST /game/gen-unique-flag-name', 'POST /game/create-flag', 'POST /game/remove-flag'],
    setup(dump) {
      // two documents for one user and room: `getFlags(user)` keeps the last one per room,
      // `getFlags(user, room)` the first, and `setFlags` rewrites both
      addDocs(dump, 'rooms.flags', [
        {
          _id: 'f00000000000011',
          user: EMMA,
          room: 'W1N2',
          data: 'Flag1~1~1~10~10|Flag2~1~1~11~10',
        },
        { _id: 'f00000000000012', user: EMMA, room: 'W1N2', data: 'Flag3~2~2~12~10' },
      ]);
    },
    steps: [
      genFlagName(EMMA),
      checkFlagName(EMMA, 'Flag2'),
      removeFlag(EMMA, { room: 'W1N2', name: 'Flag1' }),
      createFlag(EMMA, { room: 'W1N2', x: 20, y: 20, name: 'Flag4', color: 3, secondaryColor: 3 }),
    ],
  },
  {
    name: 'gameplay.spawn.place-levelless-controller',
    covers: ['POST /game/place-spawn'],
    setup(dump) {
      addDocs(dump, 'users', [user(NEWBIE, 'Newbie')]);
      // upstream claims only controllers matching `{level: 0}`
      patch(dump, 'rooms.objects', W3N3_CONTROLLER, { level: undefined });
    },
    steps: [placeSpawn(NEWBIE, { room: 'W3N3', x: 30, y: 25, name: 'Spawn1' })],
  },
  {
    name: 'gameplay.flags.escapes',
    covers: [
      'POST /game/create-flag',
      'POST /game/check-unique-flag-name',
      'POST /game/change-flag-color',
      'POST /game/remove-flag',
    ],
    steps: [
      createFlag(EMMA, { room: 'W1N1', x: 10, y: 10, name: 'a|b~c', color: 1, secondaryColor: 2 }),
      createFlag(EMMA, {
        room: 'W1N1',
        x: 11,
        y: 10,
        name: '$VLINE$',
        color: 1,
        secondaryColor: 2,
      }),
      createFlag(EMMA, { room: 'W1N1', x: 12, y: 10, name: '~~||', color: 1, secondaryColor: 2 }),
      checkFlagName(EMMA, 'a|b~c'),
      checkFlagName(EMMA, '|'),
      changeFlagColor(EMMA, { room: 'W1N1', name: 'a|b~c', color: 9, secondaryColor: 9 }),
      createFlag(EMMA, { room: 'W2N2', x: 10, y: 10, name: '~~||', color: 4, secondaryColor: 4 }),
      removeFlag(EMMA, { room: 'W1N1', name: 'a|b~c' }),
      removeFlag(EMMA, { room: 'W1N1', name: '|' }),
    ],
  },
  {
    name: 'gameplay.flags.limit',
    covers: ['POST /game/create-flag'],
    setup(dump) {
      addDocs(dump, 'rooms.flags', [
        { _id: 'f00000000000001', user: EMMA, room: 'W1N2', data: flagsAt(5000, 'W1N2') },
        {
          _id: 'f00000000000002',
          user: EMMA,
          room: 'W1N3',
          data: flagsAt(4998, 'W1N3').replace(/F/g, 'G'),
        },
        { _id: 'f00000000000003', user: MICHAEL, room: 'W9N9', data: flagsAt(10001, 'W9N9') },
      ]);
    },
    steps: [
      createFlag(EMMA, { room: 'W1N1', x: 10, y: 10, name: 'one', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: 11, y: 10, name: 'two', color: 1, secondaryColor: 1 }),
      createFlag(EMMA, { room: 'W1N1', x: 12, y: 10, name: 'three', color: 1, secondaryColor: 1 }),
      // re-creating an existing flag at the limit moves it
      createFlag(EMMA, { room: 'W1N4', x: 12, y: 10, name: 'F7', color: 2, secondaryColor: 2 }),
      createFlag(EMMA, { room: 'W1N1', x: 12, y: 10, name: 'two', color: 3, secondaryColor: 3 }),
      // over the limit: the old flag is removed before the limit check rejects the new one
      createFlag(MICHAEL, { room: 'W9N8', x: 12, y: 10, name: 'F3', color: 2, secondaryColor: 2 }),
      createFlag(MICHAEL, { room: 'W9N9', x: 12, y: 10, name: 'F4', color: 2, secondaryColor: 2 }),
      genFlagName(MICHAEL),
    ],
  },

  /* ------------------------------------------------------------ construction */
  {
    name: 'gameplay.construction.rcl1',
    covers: ['POST /game/create-construction'],
    setup(dump) {
      patch(dump, 'rooms', 'W3N3', { status: 'out of borders' });
    },
    steps: [
      construct(EMMA, { room: 'W1N1', x: 10, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W1N1', x: 18, y: 10, structureType: 'road' }), // swamp
      construct(EMMA, { room: 'W1N1', x: 13, y: 12, structureType: 'road' }), // wall
      construct(EMMA, { room: 'W1N1', x: 38, y: 6, structureType: 'road' }), // wall + swamp
      construct(EMMA, { room: 'W1N1', x: 11, y: 10, structureType: 'container' }),
      construct(EMMA, { room: 'W1N1', x: 12, y: 13, structureType: 'container' }), // wall
      construct(EMMA, { room: 'W1N1', x: 12, y: 10, structureType: 'extension' }), // RCL
      construct(EMMA, { room: 'W1N1', x: 12, y: 10, structureType: 'spawn', name: 'Spawn2' }),
      construct(EMMA, { room: 'W1N1', x: 12, y: 10, structureType: 'spawn' }),
      construct(EMMA, { room: 'W1N1', x: 12, y: 10, structureType: 'spawn', name: 'x'.repeat(51) }),
      construct(EMMA, { room: 'W1N1', x: 12, y: 10, structureType: 'spawn', name: 12 }),
      construct(EMMA, { room: 'W1N1', x: 12, y: 10, structureType: 'road', name: 'named road' }),
      construct(EMMA, { room: 'W1N1', x: 10, y: 10, structureType: 'road' }), // site already here
      construct(EMMA, { room: 'W1N1', x: 10, y: 10, structureType: 'rampart' }),
      construct(EMMA, { room: 'W1N1', x: 37, y: 31, structureType: 'road' }), // on the spawn
      construct(EMMA, { room: 'W1N1', x: 37, y: 31, structureType: 'rampart' }),
      construct(EMMA, { room: 'W1N1', x: 42, y: 22, structureType: 'road' }), // on the controller
      construct(EMMA, { room: 'W1N1', x: 30, y: 27, structureType: 'container' }), // on a source
      construct(EMMA, { room: 'W1N1', x: 7, y: 33, structureType: 'extractor' }),
      construct(EMMA, { room: 'W1N1', x: 8, y: 33, structureType: 'extractor' }),
      construct(EMMA, { room: 'W1N1', x: 0, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W1N1', x: 49, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W1N1', x: 50, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W1N1', x: 10, y: -1, structureType: 'road' }),
      construct(EMMA, { room: 'W1N1', x: 10, y: 10, structureType: 'bogus' }),
      construct(EMMA, { room: 'W1N1', x: 10, y: 10, structureType: 'controller' }),
      construct(EMMA, { room: 'W1N1', x: '14', y: '10.9', structureType: 'road' }),
      construct(EMMA, { room: 'W40N40', x: 10, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W3N3', x: 10, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W9N9', x: 10, y: 10, structureType: 'road' }), // other player's room
      construct(EMMA, { room: 'W2N2', x: 10, y: 10, structureType: 'road' }), // neutral room
      construct(EMMA, { room: 'W2N2', x: 11, y: 10, structureType: 'spawn', name: 'Remote' }), // RCL 0
      construct(EMMA, { room: 'W5N5', x: 10, y: 10, structureType: 'container' }), // no controller
    ],
  },
  {
    name: 'gameplay.construction.rcl8',
    covers: ['POST /game/create-construction'],
    setup(dump) {
      patch(dump, 'rooms.objects', EMMA_CONTROLLER, { level: 8 });
      // every probed structure type (rows y=30..33) against every blocker type (columns x=15..20)
      const blockers = [
        { type: 'constructedWall', hits: 1, hitsMax: 300000000 },
        { type: 'rampart', user: EMMA, hits: 1, hitsMax: 300000000 },
        { type: 'container', hits: 1, hitsMax: 250000, store: {} },
        { type: 'road', hits: 1, hitsMax: 5000 },
        { type: 'lab', user: EMMA, hits: 1, hitsMax: 500, store: {} },
        { type: 'tower', user: EMMA, hits: 1, hitsMax: 3000, store: {} },
      ];
      const docs = [];
      for (const [row, y] of [30, 31, 32, 33].entries()) {
        for (const [column, blocker] of blockers.entries()) {
          docs.push({
            _id: `c000000000002${String(row)}${String(column)}`,
            room: 'W1N1',
            x: 15 + column,
            y,
            ...blocker,
          });
        }
      }
      addDocs(dump, 'rooms.objects', docs);
    },
    steps: [
      ...[
        'spawn',
        'extension',
        'road',
        'constructedWall',
        'rampart',
        'link',
        'storage',
        'tower',
        'observer',
        'powerSpawn',
        'extractor',
        'lab',
        'terminal',
        'container',
        'nuker',
        'factory',
      ].map((structureType, i) =>
        construct(EMMA, {
          room: 'W1N1',
          x: 3 + i,
          y: 5,
          structureType,
          name: structureType === 'spawn' ? 'Spawn2' : undefined,
        }),
      ),
      // wall tiles
      ...['extension', 'rampart', 'road'].map((structureType) =>
        construct(EMMA, { room: 'W1N1', x: 12, y: 16, structureType }),
      ),
      ...['rampart', 'extension', 'link', 'road'].flatMap((structureType, row) =>
        [15, 16, 17, 18, 19, 20].map((x) =>
          construct(EMMA, { room: 'W1N1', x, y: 30 + row, structureType }),
        ),
      ),
      // border tiles: next to exits vs. next to walls only
      construct(EMMA, { room: 'W1N1', x: 1, y: 7, structureType: 'extension' }),
      construct(EMMA, { room: 'W1N1', x: 9, y: 1, structureType: 'extension' }),
      construct(EMMA, { room: 'W1N1', x: 34, y: 1, structureType: 'extension' }),
      construct(EMMA, { room: 'W1N1', x: 9, y: 48, structureType: 'rampart' }),
      construct(EMMA, { room: 'W1N1', x: 9, y: 48, structureType: 'road' }),
      construct(EMMA, { room: 'W1N1', x: 10, y: 48, structureType: 'container' }),
      construct(EMMA, { room: 'W1N1', x: 23, y: 48, structureType: 'extension' }),
      // extractor on a mineral that already has one (W5N5) and on a mineral with a site
      construct(EMMA, { room: 'W5N5', x: 42, y: 32, structureType: 'extractor' }),
      construct(EMMA, { room: 'W1N1', x: 7, y: 33, structureType: 'extractor' }),
      construct(EMMA, { room: 'W1N1', x: 7, y: 33, structureType: 'extractor' }),
      // RCL 8 limit: a second observer
      construct(EMMA, { room: 'W1N1', x: 30, y: 16, structureType: 'observer' }),
    ],
  },
  {
    name: 'gameplay.construction.reserved-and-limit',
    covers: ['POST /game/create-construction'],
    setup(dump) {
      patch(dump, 'rooms.objects', W2N2_CONTROLLER, { reservation: { user: EMMA, endTime: 3000 } });
      patch(dump, 'rooms.objects', W2N1_CONTROLLER, {
        reservation: { user: MICHAEL, endTime: 3000 },
      });
      const sites = [];
      for (let i = 0; i < 98; i++) {
        sites.push({
          _id: `d${String(i).padStart(14, '0')}`,
          type: 'constructionSite',
          room: 'W1N2',
          x: 10 + (i % 30),
          y: 10 + Math.floor(i / 30),
          structureType: 'road',
          user: EMMA,
          progress: 0,
          progressTotal: 300,
        });
      }
      addDocs(dump, 'rooms.objects', sites);
    },
    steps: [
      construct(EMMA, { room: 'W2N1', x: 20, y: 20, structureType: 'road' }),
      construct(EMMA, { room: 'W2N2', x: 10, y: 10, structureType: 'road' }),
      construct(EMMA, { room: 'W2N2', x: 11, y: 10, structureType: 'container' }),
      construct(EMMA, { room: 'W2N2', x: 12, y: 10, structureType: 'road' }),
      construct(MICHAEL, { room: 'W2N2', x: 13, y: 10, structureType: 'road' }),
    ],
  },

  /* ------------------------------------------------------------ intents */
  {
    name: 'gameplay.intents.object',
    covers: ['POST /game/add-object-intent'],
    setup(dump) {
      patch(dump, 'rooms', 'W3N3', { status: 'out of borders' });
    },
    steps: [
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: EMMA_SPAWN,
        name: 'createCreep',
        intent: {
          name: 'c1',
          body: ['move', 'work', 'bogus'],
          energyStructures: [EMMA_SPAWN],
          directions: ['1', 2],
        },
      }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: EMMA_SPAWN,
        name: 'notifyWhenAttacked',
        intent: { enabled: 1 },
      }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: EMMA_SPAWN,
        name: 'createCreep',
        intent: { name: 'c2', body: ['carry'] },
      }),
      objectIntent(EMMA, { room: 'W1N1', _id: EMMA_CONTROLLER, name: 'unclaim', intent: {} }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: EMMA_CONTROLLER,
        name: 'bogusIntent',
        intent: { a: 1 },
      }),
      objectIntent(EMMA, { room: 'W1N1', _id: EMMA_SPAWN, name: 'cancelSpawning' }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: 'room',
        name: 'createFlag',
        intent: [{ roomName: 'W1N1', x: 5, y: '6', name: 'F', color: 1, secondaryColor: 2 }],
      }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: 'room',
        name: 'createFlag',
        intent: [{ roomName: 'W1N1', x: 7, y: 8, name: 'G', color: 3 }],
      }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: 'room',
        name: 'removeFlag',
        intent: [
          { roomName: 'W1N1', name: 'F' },
          { roomName: 'W1N1', name: 'G' },
        ],
      }),
      objectIntent(EMMA, { room: 'W1N1', _id: 'room', name: 'removeFlag', intent: [] }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: 'room',
        name: 'say',
        intent: { message: 'room-level say' },
      }),
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: 'room',
        name: 'move',
        intent: [{ direction: '3' }, 5],
      }),
      objectIntent(EMMA, { room: 'W1N1', _id: EMMA_SPAWN, intent: { a: 1 } }),
      objectIntent(EMMA, {
        room: 'W40N40',
        _id: EMMA_SPAWN,
        name: 'notifyWhenAttacked',
        intent: { enabled: true },
      }),
      objectIntent(EMMA, {
        room: 'W3N3',
        _id: EMMA_SPAWN,
        name: 'notifyWhenAttacked',
        intent: { enabled: true },
      }),
    ],
  },
  {
    name: 'gameplay.intents.ownership',
    covers: ['POST /game/add-object-intent'],
    setup(dump) {
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000060',
          type: 'terminal',
          room: 'W9N9',
          x: 10,
          y: 10,
          store: { energy: 1000 },
          hits: 3000,
          hitsMax: 3000,
        },
      ]);
    },
    steps: [
      [MICHAEL_SPAWN, 'W9N9', 'notifyWhenAttacked', { enabled: true }, 'not owner'],
      [
        'c00000000000060',
        'W9N9',
        'send',
        { targetRoomName: 'W1N1', resourceType: 'energy', amount: 500 },
        'not owner',
      ],
      ['c0000000000ffff', 'W1N1', 'notifyWhenAttacked', { enabled: true }, 'invalid object'],
      [EMMA_SPAWN, 'W9N9', 'notifyWhenAttacked', { enabled: true }, 'invalid object'],
    ].map(([target, room, name, intent, error], index, all) => ({
      ...objectIntent(EMMA, { room, _id: target, name, intent }),
      expected: [foreignIntent(all.slice(0, index + 1), { target, room, error })],
    })),
  },
  {
    name: 'gameplay.intents.malformed',
    covers: ['POST /game/add-object-intent'],
    steps: [
      ['room', 'destroyStructure', { roomName: 'W1N1', id: EMMA_SPAWN }],
      [
        'room',
        'createFlag',
        [{ roomName: 'W2N2', x: 5, y: 5, name: 'Far', color: 1, secondaryColor: 1 }],
      ],
      ['room', 'createConstructionSite', [{ x: 5, y: 5, structureType: 'road' }]],
      [EMMA_SPAWN, 'createCreep', [{ name: 'c1', body: ['move'] }]],
    ].map(([target, name, intent]) => ({
      ...objectIntent(EMMA, { room: 'W1N1', _id: target, name, intent }),
      expected: [malformedIntent(target, name)],
    })),
  },
  {
    name: 'gameplay.intents.safe-mode',
    covers: ['POST /game/add-object-intent'],
    setup(dump) {
      patch(dump, 'rooms.objects', EMMA_CONTROLLER, { safeMode: 0 });
      patch(dump, 'rooms.objects', W2N2_CONTROLLER, { user: EMMA, level: 1, safeMode: 0 });
    },
    steps: [
      // the route only refuses while one of the player's rooms is in safe mode; the processor
      // checks availability, cooldown and downgrade
      objectIntent(EMMA, {
        room: 'W1N1',
        _id: EMMA_CONTROLLER,
        name: 'activateSafeMode',
        intent: {},
      }),
      objectIntent(EMMA, {
        room: 'W2N2',
        _id: W2N2_CONTROLLER,
        name: 'activateSafeMode',
        intent: {},
      }),
      objectIntent(EMMA, { room: 'W1N1', _id: EMMA_SPAWN, name: 'activateSafeMode', intent: {} }),
      objectIntent(MICHAEL, {
        room: 'W9N9',
        _id: MICHAEL_SPAWN,
        name: 'activateSafeMode',
        intent: {},
      }),
    ],
  },
  {
    name: 'gameplay.intents.global',
    covers: ['POST /game/add-global-intent'],
    steps: [
      globalIntent(EMMA, {
        name: 'createPowerCreep',
        intent: { name: 'pc', className: 'operator', extra: 1 },
      }),
      globalIntent(EMMA, { name: 'createPowerCreep', intent: { name: 7, className: 'operator' } }),
      globalIntent(EMMA, {
        name: 'createOrder',
        intent: {
          type: 'sell',
          resourceType: 'energy',
          price: 0.0125,
          totalAmount: '100',
          roomName: 'W1N1',
        },
      }),
      globalIntent(EMMA, {
        name: 'deal',
        intent: { orderId: 'abc', amount: 5, targetRoomName: 'W1N1' },
      }),
      globalIntent(EMMA, { name: 'bogus', intent: { a: 1 } }),
      globalIntent(MICHAEL, { name: 'notify', intent: { message: 'hi', groupInterval: 5 } }),
      globalIntent(MICHAEL, { name: 'generatePixel', intent: {} }),
    ],
  },

  /* ------------------------------------------------------------ objects, invaders */
  {
    name: 'gameplay.objects.notify-when-attacked',
    covers: ['POST /game/set-notify-when-attacked'],
    setup(dump) {
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000030',
          type: 'road',
          room: 'W1N1',
          x: 10,
          y: 10,
          hits: 5000,
          hitsMax: 5000,
          notifyWhenAttacked: true,
        },
        {
          _id: 'c00000000000031',
          type: 'road',
          room: 'W9N9',
          x: 10,
          y: 10,
          hits: 5000,
          hitsMax: 5000,
        },
      ]);
    },
    steps: [
      [EMMA, EMMA_SPAWN, true],
      [EMMA, EMMA_SPAWN, 0],
      [EMMA, MICHAEL_SPAWN, true],
      [EMMA, 'c00000000000030', false],
      [EMMA, 'c00000000000031', false],
      [EMMA, EMMA_CONTROLLER, false],
      [EMMA, '1d190775111f525', false], // a source in W1N1
    ].map(([userId, id, enabled]) =>
      game('post', '/set-notify-when-attacked', {
        user: userId,
        body: { _id: id, enabled },
        local: (l, g) => g.setNotifyWhenAttacked(l.state, userId, { id, enabled: !!enabled }),
      }),
    ),
  },
  {
    name: 'gameplay.invaders.lifecycle',
    covers: ['POST /game/create-invader', 'POST /game/remove-invader'],
    setup(dump) {
      patch(dump, 'rooms.objects', W2N2_CONTROLLER, { reservation: { user: EMMA, endTime: 3000 } });
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000040',
          type: 'creep',
          room: 'W2N1',
          x: 20,
          y: 20,
          user: MICHAEL,
          name: 'm1',
          body: [],
          hits: 100,
          hitsMax: 100,
          store: {},
        },
      ]);
      patch(dump, 'rooms.objects', W2N1_CONTROLLER, { reservation: { user: EMMA, endTime: 3000 } });
      // the route has no `checkGame`: an owned room outside the borders still gets invaders
      patch(dump, 'rooms', 'W2N2', { status: 'out of borders' });
    },
    steps: [
      ...[
        { room: 'W1N1', x: 10, y: 10, size: 'small', type: 'Melee' },
        { room: 'W1N1', x: 11, y: 10, size: 'big', type: 'Healer', boosted: true },
        { room: 'W1N1', x: 12, y: 10, size: 'small', type: 'Ranged', boosted: 1 },
        { room: 'W2N2', x: 13, y: 10, size: 'big', type: 'Melee', boosted: true },
        { room: 'W3N3', x: 13, y: 10, size: 'small', type: 'Ranged' }, // not owned
        { room: 'W1N1', x: 13, y: 12, size: 'small', type: 'Healer' }, // wall
        { room: 'W1N1', x: 14, y: 10, size: 'small', type: 'Melee' },
        { room: 'W1N1', x: 15, y: 10, size: 'small', type: 'Melee' }, // sixth
        { room: 'W9N9', x: 15, y: 10, size: 'small', type: 'Melee' },
        { room: 'W2N1', x: 15, y: 10, size: 'small', type: 'Melee' },
        { room: 'W5N5', x: 15, y: 10, size: 'small', type: 'Melee' },
      ].map(invader),
      ...[
        [MICHAEL, 'first'],
        [EMMA, 'first'],
        [EMMA, 'first'],
        [EMMA, EMMA_SPAWN],
        [EMMA, 'missing'],
      ].map(([userId, target]) => ({
        op: `POST /remove-invader ${target} as ${userId}`,
        upstream: async (o) => {
          const id =
            target === 'first'
              ? (
                  await o.db['rooms.objects'].findOne({
                    $and: [{ type: 'creep' }, { userSummoned: EMMA }],
                  })
                )?._id
              : target;
          return o.api('game', 'post', '/remove-invader', { userId, body: { _id: id } });
        },
        local: (l, g) => {
          const id =
            target === 'first'
              ? Object.values(l.state.world.roomObjects).find(
                  (o) => o.type === 'creep' && o.userSummoned === EMMA,
                )?._id
              : target;
          return g.removeInvader(l.state, userId, id);
        },
        result: apiBody(() => undefined),
      })),
    ],
  },
  {
    name: 'gameplay.invaders.coordinates',
    covers: ['POST /game/create-invader'],
    steps: [
      {
        ...invader({ room: 'W1N1', x: '13', y: '10', size: 'big', type: 'Ranged' }),
        result: apiBody((data) => {
          const { x, y, ...rest } = created(data);
          void x;
          void y;
          return rest;
        }),
        expected: [invaderCoordinates()],
      },
    ],
  },

  /* ------------------------------------------------------------ power creeps */
  {
    name: 'gameplay.power-creeps.lifecycle',
    covers: [
      'GET /game/power-creeps/list',
      'POST /game/power-creeps/create',
      'POST /game/power-creeps/delete',
      'POST /game/power-creeps/cancel-delete',
      'POST /game/power-creeps/upgrade',
      'POST /game/power-creeps/rename',
      'POST /game/power-creeps/experimentation',
    ],
    setup(dump) {
      // GPL 10: one level per creep plus every creep level
      addDocs(dump, 'users', [
        user(POWER_USER, 'Powerful', { power: 100000, powerExperimentations: 1 }),
      ]);
      addDocs(dump, 'users.power_creeps', [
        {
          _id: 'e00000000000001',
          name: 'Spawned',
          className: 'operator',
          user: POWER_USER,
          level: 2,
          hitsMax: 3000,
          store: {},
          storeCapacity: 300,
          spawnCooldownTime: null,
          powers: { 1: { level: 1 }, 2: { level: 1, cooldownTime: 50 } },
        },
        {
          _id: 'e00000000000002',
          name: 'Other',
          className: 'operator',
          user: MICHAEL,
          level: 0,
          hitsMax: 1000,
          store: {},
          storeCapacity: 100,
          spawnCooldownTime: 0,
          powers: {},
        },
      ]);
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'e00000000000001',
          type: 'powerCreep',
          room: 'W2N2',
          x: 10,
          y: 10,
          user: POWER_USER,
          name: 'Spawned',
          className: 'operator',
          level: 2,
          hits: 3000,
          hitsMax: 3000,
          store: {},
          storeCapacity: 300,
          powers: { 1: { level: 1 }, 2: { level: 1, cooldownTime: 50 } },
          ageTime: 5000,
        },
      ]);
    },
    steps: [
      listPowerCreeps(POWER_USER),
      createPowerCreep(POWER_USER, { name: 'Alpha', className: 'operator' }),
      createPowerCreep(POWER_USER, { name: 'Alpha', className: 'operator' }),
      createPowerCreep(POWER_USER, { name: 'Beta', className: 'warrior' }),
      createPowerCreep(POWER_USER, { name: 'B'.repeat(60), className: 'operator' }),
      createPowerCreep(POWER_USER, { className: 'operator' }),
      createPowerCreep(POWER_USER, { name: 12, className: 'operator' }),
      createPowerCreep(EMMA, { name: 'Alpha', className: 'operator' }),
      listPowerCreeps(POWER_USER),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2, 2: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 1, 2: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 3, 2: 1, 3: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2, 999: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2, 2: '1' } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 6, 2: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2, 2: 1, 3: 0 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2, 2: 2, 3: 2, 13: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', {}),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 5, 2: 5, 3: 5, 5: 5, 6: 5, 7: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 2, 2: 1, 5: 1 } }),
      powerById('upgrade', POWER_USER, 'Alpha', { powers: { 1: 3, 2: 2 } }),
      powerById('upgrade', POWER_USER, 'Spawned', { powers: { 1: 1, 2: 2 } }),
      powerById('upgrade', POWER_USER, 'Other', { powers: { 1: 1 } }),
      powerById('rename', POWER_USER, 'Alpha', { name: 'Gamma' }),
      powerById('rename', POWER_USER, 'Gamma', { name: 'Spawned' }),
      powerById('rename', POWER_USER, 'Spawned', { name: 'Delta' }),
      powerById('rename', POWER_USER, 'Other', { name: 'Delta' }),
      powerById('delete', POWER_USER, 'Spawned'),
      powerById('delete', POWER_USER, 'Other'),
      powerById('delete', POWER_USER, 'Gamma'),
      powerById('delete', POWER_USER, 'Gamma'),
      powerById('cancel-delete', POWER_USER, 'Gamma'),
      powerById('cancel-delete', POWER_USER, 'Gamma'),
      powerById('cancel-delete', POWER_USER, 'Other'),
      experimentation(EMMA),
      experimentation(POWER_USER),
      experimentation(POWER_USER),
      powerById('upgrade', POWER_USER, 'Spawned', { powers: { 1: 1, 2: 2 } }),
      listPowerCreeps(POWER_USER),
      listPowerCreeps(MICHAEL),
      // last: the original crashes here and keeps the creep (state differs from now on)
      { ...powerById('delete', POWER_USER, 'Gamma'), expected: [experimentationDelete('Gamma')] },
    ],
  },
  {
    name: 'gameplay.power-creeps.fractional-level',
    covers: ['POST /game/power-creeps/upgrade'],
    setup(dump) {
      addDocs(dump, 'users', [user(POWER_USER, 'Powerful', { power: 100000 })]);
      addDocs(dump, 'users.power_creeps', [
        {
          _id: 'e00000000000003',
          name: 'Frac',
          className: 'operator',
          user: POWER_USER,
          level: 0,
          hitsMax: 1000,
          store: {},
          storeCapacity: 100,
          spawnCooldownTime: 0,
          powers: {},
        },
      ]);
    },
    steps: [
      powerById('upgrade', POWER_USER, 'Frac', { powers: { 1: -1 } }),
      powerById('upgrade', POWER_USER, 'Frac', { powers: { 1: 5.5 } }),
      {
        ...powerById('upgrade', POWER_USER, 'Frac', { powers: { 1: 0.5 } }),
        expected: [fractionalPowerLevel('e00000000000003')],
      },
    ],
  },

  /* ------------------------------------------------------------ market */
  {
    name: 'gameplay.market.views',
    covers: [
      'GET /game/market/orders-index',
      'GET /game/market/orders',
      'GET /game/market/my-orders',
      'GET /game/market/stats',
    ],
    setup(dump) {
      addDocs(dump, 'market.orders', MARKET_ORDERS);
      addDocs(dump, 'market.stats', [
        {
          _id: 's00000000000001',
          resourceType: 'energy',
          date: '2026-01-13',
          transactions: 3,
          volume: 30,
          avgPrice: 1.2,
          stddevPrice: 0.1,
        },
        {
          _id: 's00000000000002',
          resourceType: 'energy',
          date: '2026-01-14',
          transactions: 4,
          volume: 40,
          avgPrice: 1.3,
          stddevPrice: 0.2,
        },
        {
          _id: 's00000000000003',
          resourceType: 'H',
          date: '2026-01-14',
          transactions: 1,
          volume: 5,
          avgPrice: 0.3,
          stddevPrice: 0,
        },
      ]);
    },
    steps: [
      market('get', '/orders-index', {
        user: EMMA,
        local: (l, g) => ({ list: g.marketOrderIndex(l.state.world) }),
        result: apiBody((data) => ({ list: data.list })),
      }),
      ...['energy', 'H', 'O', undefined].map((resourceType) =>
        market('get', '/orders', {
          user: EMMA,
          query: resourceType === undefined ? {} : { resourceType },
          local: (l, g) => ({ list: g.activeMarketOrders(l.state.world, resourceType) }),
          result: apiBody((data) => ({ list: data.list.map(doc) })),
        }),
      ),
      ...[EMMA, MICHAEL, ALICE].map((userId) =>
        market('get', '/my-orders', {
          user: userId,
          local: (l, g) => ({ list: g.userMarketOrders(l.state.world, userId) }),
          result: apiBody((data) => ({ list: data.list.map(doc) })),
        }),
      ),
      ...['energy', 'H', 'O', undefined].map((resourceType) =>
        market('get', '/stats', {
          user: EMMA,
          query: resourceType === undefined ? {} : { resourceType },
          local: (l, g) => ({ stats: g.marketHistory(l.state.world, resourceType) }),
          result: apiBody((data) => ({ stats: data.stats.map(doc) })),
        }),
      ),
    ],
  },

  /* ------------------------------------------------------------ user: world, code branches */
  {
    name: 'gameplay.user.world-status',
    covers: ['GET /user/world-status'],
    setup(dump) {
      addDocs(dump, 'users', [user(NEWBIE, 'Newbie'), user(NEWBIE2, 'Newbie2')]);
      addDocs(dump, 'rooms.objects', [
        {
          _id: 'c00000000000050',
          type: 'spawn',
          room: 'W2N2',
          x: 10,
          y: 10,
          user: NEWBIE2,
          name: 'Spawn1',
          hits: 5000,
          hitsMax: 5000,
        },
      ]);
    },
    steps: [EMMA, NEWBIE, NEWBIE2].map((userId) =>
      userRoute('get', '/world-status', {
        user: userId,
        local: (l, g) => ({ status: g.getUserWorldStatus(l.state.world, userId) }),
        result: apiBody(body(['status'])),
      }),
    ),
  },
  {
    name: 'gameplay.user.code-branches',
    covers: [
      'GET /user/branches',
      'GET /user/code',
      'POST /user/code',
      'POST /user/set-active-branch',
      'POST /user/clone-branch',
      'POST /user/delete-branch',
    ],
    setup(dump) {
      addDocs(dump, 'users', [user(NEWBIE, 'Newbie')]);
    },
    steps: [
      branches(NEWBIE),
      getCode(NEWBIE, undefined),
      getCode(NEWBIE, 'default'),
      saveCode(NEWBIE, { modules: { main: 'module.exports.loop = () => {};' } }),
      saveCode(NEWBIE, {
        branch: 'default',
        modules: { main: 'loop', 'lib.util': 'x', util: 'y', $bad: 'z' },
      }),
      getCode(NEWBIE, 'default'),
      setActive(NEWBIE, 'activeWorld', 'default'),
      setActive(NEWBIE, 'activeSim', 'default'),
      setActive(NEWBIE, 'activeWorld', 'missing'),
      setActive(NEWBIE, 'activeFoo', 'default'),
      getCode(NEWBIE, undefined),
      getCode(NEWBIE, '$activeSim'),
      saveCode(NEWBIE, { modules: { main: 'world code' } }),
      clone(NEWBIE, { branch: 'default', newName: 'copy' }),
      clone(NEWBIE, { newName: 'fresh', defaultModules: { main: 'fresh code', 'a.b': 'c' } }),
      clone(NEWBIE, { newName: 'empty' }),
      clone(NEWBIE, { branch: 'missing', newName: 'from-missing' }),
      clone(NEWBIE, { branch: 'fresh', newName: 'copy' }),
      clone(NEWBIE, { branch: 'x'.repeat(31), newName: 'long' }),
      branches(NEWBIE),
      saveCode(NEWBIE, { branch: 'copy', modules: { main: 'copy code' } }),
      saveCode(NEWBIE, { branch: 'missing', modules: { main: 'nowhere' } }),
      deleteBranch(NEWBIE, 'default'),
      deleteBranch(NEWBIE, 'empty'),
      deleteBranch(NEWBIE, 'missing'),
      setActive(NEWBIE, 'activeSim', 'copy'),
      deleteBranch(NEWBIE, 'default'),
      branches(NEWBIE),
      branches(EMMA),
    ],
  },
  {
    name: 'gameplay.user.branch-limit',
    covers: ['POST /user/clone-branch'],
    setup(dump) {
      const docs = [];
      for (let i = 0; i < 30; i++) {
        docs.push({
          _id: `a${String(i).padStart(14, '0')}`,
          user: NEWBIE,
          branch: `b${String(i)}`,
          modules: { main: '' },
          timestamp: 1000 + i,
          activeWorld: i === 0,
          activeSim: i === 0,
        });
      }
      addDocs(dump, 'users', [user(NEWBIE, 'Newbie')]);
      addDocs(dump, 'users.code', docs);
    },
    steps: [
      clone(NEWBIE, { newName: 'b30' }),
      clone(NEWBIE, { branch: 'b1', newName: 'b2' }),
      clone(NEWBIE, { newName: 'tutorial-1' }),
      clone(NEWBIE, { newName: 'tutorial-2' }),
      deleteBranch(NEWBIE, 'b5'),
      clone(NEWBIE, { newName: 'b30' }),
      clone(NEWBIE, { newName: 'b31' }),
    ],
  },
];

/* ---------------------------------------------------------------- power creep steps */

function listPowerCreeps(userId) {
  return power('get', '/list', {
    user: userId,
    local: (l, g) => ({ list: g.listPowerCreeps(l.state.world, userId) }),
    // LokiJS returns `users.power_creeps` in binary-index order of `user` (unspecified for equal
    // users) and new creeps carry side-specific ids: compare by name, fixture ids verbatim.
    result: apiBody((data) => ({
      list: data.list
        .map((item) => (/^e0{11}\d{3}$/.test(item._id) ? doc(item) : created(item)))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    })),
  });
}

function createPowerCreep(userId, input) {
  return power('post', '/create', {
    user: userId,
    body: input,
    // upstream stores `("" + name).substring(0, 50)` of the raw request value
    local: (l, g) =>
      g.createPowerCreep(l.state, userId, { className: str(input.className), name: input.name }),
    result: apiBody(created),
  });
}

/** A power creep route addressing a creep by name (ids differ between the two sides). */
function powerById(path, userId, name, input = {}) {
  const findId = (creeps) => creeps.find((creep) => creep.name === name)?._id ?? name;
  return {
    op: `POST /power-creeps/${path} ${name} ${JSON.stringify(input)} as ${userId}`,
    upstream: async (o) => {
      const id = findId(await o.db['users.power_creeps'].find({}));
      return o.api('powerCreeps', 'post', `/${path}`, { userId, body: { id, ...input } });
    },
    local: (l, g) => {
      const id = findId(Object.values(l.state.world.userPowerCreeps));
      switch (path) {
        case 'upgrade':
          return g.upgradePowerCreep(l.state, userId, { id, powers: input.powers });
        case 'rename':
          return g.renamePowerCreep(l.state, userId, { id, name: input.name });
        case 'delete':
          return g.deletePowerCreep(l.context, userId, id);
        case 'cancel-delete':
          return g.cancelPowerCreepDelete(l.state, userId, id);
        default:
          throw new Error(path);
      }
    },
    result: apiBody(() => undefined),
  };
}

function experimentation(userId) {
  return power('post', '/experimentation', {
    user: userId,
    local: (l, g) => g.startPowerExperimentation(l.context, userId),
  });
}

/* ---------------------------------------------------------------- code branch steps */

function branches(userId) {
  return userRoute('get', '/branches', {
    user: userId,
    local: (l, g) => ({ list: structuredClone(g.listBranches(l.context, userId)) }),
    // LokiJS returns `users.code` in binary-index order of `user`, which is unspecified for equal
    // users; compare the list by branch name. Stored `new Date()` timestamps arrive as ISO strings.
    result: apiBody((data) =>
      data.list
        .map((item) => {
          const { _id, timestamp, ...rest } = doc(item);
          void _id;
          return {
            ...rest,
            timestamp: typeof timestamp === 'string' ? Date.parse(timestamp) : (timestamp ?? null),
          };
        })
        .sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0)),
    ),
  });
}

function getCode(userId, branch) {
  return userRoute('get', '/code', {
    user: userId,
    query: branch === undefined ? {} : { branch },
    local: (l, g) => {
      const found = g.findBranch(l.state, userId, branch || '$activeWorld');
      if (!found) throw new g.GameError('no code');
      return { branch: found.branch, modules: structuredClone(found.modules) };
    },
    result: apiBody(body(['branch', 'modules'])),
  });
}

function saveCode(userId, input) {
  return userRoute('post', '/code', {
    user: userId,
    body: input,
    local: (l, g) => {
      const modules = g.normalizeModules(input.modules);
      const selector =
        typeof input.branch === 'string' && input.branch !== '' ? input.branch : '$activeWorld';
      g.saveCode(l.context, userId, modules, selector);
      return { timestamp: l.context.now() };
    },
    result: apiBody(body(['timestamp'])),
  });
}

function setActive(userId, activeName, branch) {
  return userRoute('post', '/set-active-branch', {
    user: userId,
    body: { activeName, branch },
    local: (l, g) => {
      if (activeName !== 'activeWorld' && activeName !== 'activeSim')
        throw new g.GameError('invalid params');
      g.setActiveBranch(l.context, userId, activeName, branch);
    },
  });
}

function clone(userId, input) {
  return userRoute('post', '/clone-branch', {
    user: userId,
    body: input,
    local: (l, g) => {
      const { branch: source, newName, defaultModules } = input;
      if (
        source !== undefined &&
        source !== null &&
        source !== '' &&
        (typeof source !== 'string' || source.length > 30)
      ) {
        throw new g.GameError('invalid branch name');
      }
      const options = { newName, defaultModules };
      if (typeof source === 'string') options.source = source;
      g.cloneBranch(l.context, userId, options);
      return { timestamp: l.context.now() };
    },
    result: apiBody(body(['timestamp'])),
  });
}

function deleteBranch(userId, branch) {
  return userRoute('post', '/delete-branch', {
    user: userId,
    body: { branch },
    local: (l, g) => {
      g.deleteBranch(l.state, userId, branch);
      return { timestamp: l.context.now() };
    },
    result: apiBody(body(['timestamp'])),
  });
}
