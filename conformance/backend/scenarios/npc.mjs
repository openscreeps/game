/*
 * NPC players and strongholds: backend `lib/cli/bots.js`, `lib/cli/strongholds.js`,
 * `lib/strongholds.js` and `utils.respawnUser` against `game/src/world/bots.ts`,
 * `game/src/world/strongholds.ts` and `game/src/players.ts`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docs, driverAccessibleRooms, find, setGameTime, USERS } from './support.mjs';

const BOT = 'conformanceBot';
let botDirectory;

/** Bot AI directory shared by both sides (upstream reads it through `config.common.bots`). */
function botDir() {
  if (!botDirectory) {
    botDirectory = mkdtempSync(join(tmpdir(), 'screeps-conformance-bot-'));
    writeFileSync(
      join(botDirectory, 'main.js'),
      "const role = require('role.harvester');\nmodule.exports.loop = () => role.run();\n",
    );
    writeFileSync(join(botDirectory, 'role.harvester.js'), 'module.exports.run = () => {};\n');
    writeFileSync(join(botDirectory, 'notes.txt'), 'not a module');
  }
  return botDirectory;
}

const registerBot = ({ oracle }) => {
  oracle.config.common.bots[BOT] = botDir();
};

function spawnBot(room, options) {
  return {
    op: `bots.spawn(${JSON.stringify(BOT)}, ${JSON.stringify(room)}${options ? `, ${JSON.stringify(options)}` : ''})`,
    before: registerBot,
    upstream: (o) => o.modules.bots.spawn(BOT, room, options && structuredClone(options)),
    local: (l, game) =>
      game.spawnBot(
        l.context,
        BOT,
        game.loadBotModules(botDir()),
        room,
        options && structuredClone(options),
      ),
  };
}

function reloadBot() {
  return {
    op: `bots.reload(${JSON.stringify(BOT)})`,
    before: registerBot,
    upstream: (o) => o.modules.bots.reload(BOT),
    local: (l, game) => game.reloadBot(l.context, BOT, game.loadBotModules(botDir())),
  };
}

function removeBot(username) {
  return {
    op: `bots.removeUser(${JSON.stringify(username)})`,
    upstream: (o) => o.modules.bots.removeUser(username),
    local: (l, game) => game.removeBot(l.context, username),
  };
}

function spawnStronghold(room, options) {
  return {
    op: `strongholds.spawn(${JSON.stringify(room)}${options ? `, ${JSON.stringify(options)}` : ''})`,
    upstream: (o) => o.modules.strongholdsCli.spawn(room, options && structuredClone(options)),
    local: (l, game) =>
      game.spawnStronghold(l.state.world, room, options && structuredClone(options)),
  };
}

function expandStronghold(room) {
  return {
    op: `strongholds.expand(${JSON.stringify(room)})`,
    before: driverAccessibleRooms,
    upstream: (o) => o.modules.strongholdsCli.expand(room),
    local: (l, game) => game.expandStrongholdInRoom(l.state.world, room, l.context.now()),
  };
}

/** Rooms whose status upstream `respawnUser` rewrites although the player never owned them. */
function unrelatedRoomStatus(owned) {
  return {
    id: 'respawn-unrelated-room-status',
    kind: 'safety',
    reason:
      "upstream respawnUser iterates the un-awaited `rooms.objects.find` promise (`for (let i in controllers)`); every enumerable promise member issues `rooms.update({_id: undefined})`, which the JSON RPC sends as `{}` and the storage applies to EVERY room: other players' and closed rooms are reopened (status 'normal'). The local port only resets the respawned player's own controller rooms.",
    covers: (diff) =>
      diff.collection === 'rooms' &&
      diff.path === '.status' &&
      !owned.includes(diff.key) &&
      diff.upstream === 'normal',
    assertUpstream: (view) =>
      view.collections.rooms.find((r) => r._id === 'W3N3')?.status === 'normal',
    assertLocal: (view) =>
      view.collections.rooms.find((r) => r._id === 'W3N3')?.status === 'out of borders',
  };
}

function respawn(userId, owned) {
  return {
    op: `utils.respawnUser(${JSON.stringify(userId)})`,
    upstream: (o) => o.modules.utils.respawnUser(userId),
    local: (l, game) => game.respawnUser(l.state, userId),
    expected: [unrelatedRoomStatus(owned)],
  };
}

/** Diff of `env.activeRooms` (sorted sets) where local schedules exactly the extra `rooms`. */
function onlyLocalActiveRooms(diff, rooms) {
  if (diff.collection !== 'env' || diff.path !== 'env.activeRooms') return false;
  const up = new Set(diff.upstream);
  const extra = diff.local.filter((room) => !up.has(room));
  return (
    diff.local.length === up.size + rooms.length && rooms.every((room) => extra.includes(room))
  );
}

const explicitStronghold = {
  id: 'stronghold-explicit-position',
  kind: 'upstream-noop',
  reason:
    'backend lib/strongholds.js:44-45 returns `opts` before spawning when templateName, x and y are all given, so the CLI option never places anything; the local port completes the documented behaviour and places the template at that position (kept per policy: keep completed functionality where the original is a no-op).',
  coversResult: false,
  covers: (diff) =>
    (diff.collection === 'rooms.objects' &&
      diff.upstream === '<absent>' &&
      diff.local?.room === 'W6N6') ||
    onlyLocalActiveRooms(diff, ['W6N6']),
  assertUpstream: (view) =>
    !view.collections['rooms.objects'].some((o) => o.room === 'W6N6' && o.strongholdId),
  assertLocal: (view) =>
    view.collections['rooms.objects'].some(
      (o) =>
        o.room === 'W6N6' &&
        o.type === 'invaderCore' &&
        o.x === 25 &&
        o.y === 25 &&
        o.templateName === 'bunker1',
    ),
};

let w3n3Controller;
const caseInsensitiveBotName = {
  id: 'bot-username-case-insensitive',
  kind: 'safety',
  reason:
    "backend lib/cli/bots.js:68-69 only rejects an exactly equal username, so a bot 'testbot' can be created next to 'TestBot' (same usernameLower, identity confusion for other players); the local port refuses names that collide case-insensitively.",
  coversResult: true,
  covers: (diff) =>
    (diff.collection === 'users' &&
      diff.local === '<absent>' &&
      diff.upstream?.usernameLower === 'testbot') ||
    (diff.collection === 'users.code' && diff.local === '<absent>') ||
    (diff.collection === 'rooms.objects' &&
      diff.local === '<absent>' &&
      diff.upstream?.room === 'W3N3') ||
    (diff.collection === 'rooms.objects' && diff.key === w3n3Controller) ||
    (diff.collection === 'rooms' && diff.key === 'W3N3' && diff.path === '.invaderGoal') ||
    (diff.collection === 'env' &&
      diff.path.startsWith('env.memory.') &&
      diff.local === '<absent>') ||
    onlyLocalActiveRooms({ ...diff, upstream: diff.local, local: diff.upstream }, ['W3N3']),
  assertUpstream: (view, result) =>
    result.ok === true &&
    view.collections.users.filter((u) => u.usernameLower === 'testbot').length === 2,
  assertLocal: (view, result) =>
    result.error === 'User with the name "testbot" already exists' &&
    view.collections.users.filter((u) => u.usernameLower === 'testbot').length === 1,
};

export default [
  {
    name: 'npc.bots.lifecycle',
    covers: [
      'bots.spawn',
      'bots.reload',
      'bots.removeUser',
      'utils.loadBot',
      'utils.reloadBotUsers',
      'utils.respawnUser',
    ],
    steps: [
      spawnBot('W2N2'),
      spawnBot('W3N3', { username: 'TestBot', cpu: 50, gcl: 3, x: 25, y: 25 }),
      spawnBot('W1N1'),
      spawnBot('W5N5'),
      spawnBot('W7N7', { username: 'TestBot' }),
      spawnBot('W7N3', { x: 0, y: 30 }),
      reloadBot(),
      removeBot('TestBot'),
      removeBot('Nobody'),
      removeBot('Screeps'),
    ],
  },
  {
    name: 'npc.bots.names',
    covers: ['bots.spawn'],
    setup(dump) {
      // occupy many generated names so the generator has to retry and append a second name
      const users = docs(dump, 'users');
      for (const name of [
        'Jackson',
        'Aiden',
        'Liam',
        'Lucas',
        'Sophia',
        'Emma',
        'Olivia',
        'Isabella',
        'Mia',
        'Ava',
      ]) {
        users.push({
          _id: `fixturebot${name}`,
          username: `${name}Bot`,
          usernameLower: `${name.toLowerCase()}bot`,
          cpu: 100,
          gcl: 0,
          bot: 'other',
        });
      }
    },
    steps: [spawnBot('W2N2'), spawnBot('W2N3'), spawnBot('W3N2')],
  },
  {
    name: 'npc.respawn',
    covers: ['utils.respawnUser'],
    setup(dump) {
      find(dump, 'rooms', (r) => r._id === 'W3N3')[0].status = 'out of borders';
      const objects = docs(dump, 'rooms.objects');
      objects.push({
        _id: 'emmacreep',
        type: 'creep',
        user: USERS.emma,
        room: 'W1N1',
        x: 20,
        y: 20,
        body: [{ type: 'move', hits: 100 }],
        hits: 100,
        hitsMax: 100,
        store: {},
      });
      objects.push({
        _id: 'emmasite',
        type: 'constructionSite',
        user: USERS.emma,
        room: 'W1N2',
        x: 10,
        y: 10,
        structureType: 'road',
        progress: 0,
        progressTotal: 300,
      });
      objects.push({
        _id: 'emmaextension',
        type: 'extension',
        user: USERS.emma,
        room: 'W1N1',
        x: 21,
        y: 21,
        hits: 1000,
        hitsMax: 1000,
        store: { energy: 50 },
        storeCapacityResource: { energy: 50 },
      });
      objects.push({
        _id: 'emmarampart',
        type: 'rampart',
        user: USERS.emma,
        room: 'W1N2',
        x: 11,
        y: 11,
        hits: 1,
        hitsMax: 300000,
      });
      objects.push({
        _id: 'emmaruin',
        type: 'ruin',
        user: USERS.emma,
        room: 'W1N1',
        x: 22,
        y: 22,
        structure: { id: 'oldroad', type: 'road', hits: 0, hitsMax: 5000, user: USERS.emma },
        store: {},
        destroyTime: 1,
        decayTime: 500,
      });
      objects.push({
        _id: 'emmapcobject',
        type: 'powerCreep',
        user: USERS.emma,
        room: 'W1N1',
        x: 23,
        y: 23,
        name: 'pc',
        hits: 1000,
        hitsMax: 1000,
        store: {},
      });
      docs(dump, 'rooms.flags').push({
        _id: 'emmaflags',
        user: USERS.emma,
        room: 'W1N1',
        data: 'F~1~1~3~3',
      });
      docs(dump, 'users.power_creeps').push({
        _id: 'emmapc',
        user: USERS.emma,
        name: 'pc',
        className: 'operator',
        level: 0,
        hitsMax: 1000,
        store: {},
        storeCapacity: 100,
        spawnCooldownTime: 0,
        powers: {},
      });
      docs(dump, 'users').find((u) => u._id === USERS.emma).rooms = ['W1N1'];
    },
    steps: [respawn(USERS.emma, ['W1N1']), respawn(USERS.emma, ['W1N1'])],
  },
  {
    name: 'npc.strongholds.cli',
    covers: [
      'strongholds.spawn',
      'strongholds.expand',
      'strongholds.spawnStronghold',
      'strongholds.expandStronghold',
    ],
    steps: [
      spawnStronghold('W4N5'),
      spawnStronghold('W6N4', { templateName: 'bunker3' }),
      spawnStronghold('W1N1'),
      spawnStronghold('W2N2', { user: USERS.jack, deployTime: 50, templateName: 'bunker5' }),
      expandStronghold('W4N5'),
      expandStronghold('W4N5'),
      expandStronghold('W2N8'),
      {
        ...expandStronghold('W6N4'),
        before: async (s) => {
          await setGameTime(s, 2000);
          await driverAccessibleRooms(s);
        },
      },
    ],
  },
  {
    name: 'npc.strongholds.explicit-position',
    covers: ['strongholds.spawn', 'strongholds.spawnStronghold'],
    steps: [
      {
        ...spawnStronghold('W6N6', { templateName: 'bunker1', x: 25, y: 25 }),
        expected: [explicitStronghold],
      },
    ],
  },
  {
    name: 'npc.bots.username-case',
    covers: ['bots.spawn'],
    setup(dump) {
      w3n3Controller = find(
        dump,
        'rooms.objects',
        (o) => o.room === 'W3N3' && o.type === 'controller',
      )[0]._id;
    },
    steps: [
      spawnBot('W2N2', { username: 'TestBot' }),
      { ...spawnBot('W3N3', { username: 'testbot' }), expected: [caseInsensitiveBotName] },
    ],
  },
];
