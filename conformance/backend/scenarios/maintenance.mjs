/*
 * Maintenance: backend `lib/cronjobs.js` and `lib/strongholds.js` jobs run through the original
 * `system.runCronjob`, against `game/src/world/maintenance.ts` `runJob`. Scenarios run several
 * passes over evolving state (clock and game time advanced between passes).
 */

import {
  cron,
  DAY,
  docs,
  driverAccessibleRooms,
  find,
  setActiveRooms,
  setGameTime,
  USERS,
} from './support.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60 * 1000;

function setHarvested(dump, room, amount) {
  for (const source of find(dump, 'rooms.objects', (o) => o.room === room && o.type === 'source')) {
    source.invaderHarvested = amount;
  }
}

const notified = (outcome, side) => {
  if (!outcome.ok) return { error: outcome.error };
  const list =
    side === 'upstream'
      ? outcome.value.map((n) => ({ user: n.user, count: n.notifications.length }))
      : outcome.value.map((n) => ({ user: n.userId, count: n.messages.length }));
  return { ok: list.sort((a, b) => (a.user < b.user ? -1 : 1)) };
};

function sendNotifications() {
  return {
    op: 'system.runCronjob("sendNotifications")',
    upstream: async (o) => {
      o.notifications.length = 0;
      await o.modules.system.runCronjob('sendNotifications');
      await o.settle();
      return [...o.notifications];
    },
    local: (l, game) => game.runJob(l.state, 'sendNotifications', l.context.now(), l.hooks),
    result: notified,
  };
}

function powerCreep(id, user, deleteTime) {
  return {
    _id: id,
    user,
    name: id,
    className: 'operator',
    level: 2,
    hitsMax: 3000,
    store: {},
    storeCapacity: 300,
    spawnCooldownTime: null,
    deleteTime,
    powers: { 1: { level: 2 } },
  };
}

export default [
  {
    name: 'maintenance.roomsForceUpdate',
    covers: ['cronjobs.roomsForceUpdate'],
    setup(dump) {
      find(dump, 'rooms', (r) => r._id === 'W2N3')[0].status = 'out of borders';
      delete find(dump, 'rooms', (r) => r._id === 'W7N7')[0].nextForceUpdateTime;
    },
    steps: [
      cron('roomsForceUpdate'),
      cron('roomsForceUpdate', { before: (s) => setGameTime(s, 99) }),
      cron('roomsForceUpdate', { before: (s) => setGameTime(s, 200) }),
      cron('roomsForceUpdate'),
      cron('roomsForceUpdate', {
        before: async (s) => {
          await setActiveRooms(s, []);
          await setGameTime(s, 300);
        },
      }),
    ],
  },
  {
    name: 'maintenance.genPowerBanks',
    covers: ['cronjobs.genPowerBanks'],
    setup(dump) {
      find(dump, 'rooms', (r) => r._id === 'W10N3')[0].status = 'out of borders';
      delete find(dump, 'rooms', (r) => r._id === 'W10N6')[0].powerBankTime;
    },
    steps: [
      cron('genPowerBanks'),
      cron('genPowerBanks', { before: (s) => setGameTime(s, 100000) }),
      cron('genPowerBanks'),
      cron('genPowerBanks', { before: (s) => setGameTime(s, 200000) }),
    ],
  },
  {
    // Every wall tile next to an open tile holds an object: upstream ignores objects and places
    // the bank on one of them; the baseline port skipped such tiles and gave up after 1000 draws.
    name: 'maintenance.genPowerBanks.occupied-spots',
    covers: ['cronjobs.genPowerBanks'],
    setup(dump) {
      let terrain = '';
      for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++)
          terrain += x >= 24 && x <= 26 && y >= 24 && y <= 26 ? '0' : '1';
      }
      find(dump, 'rooms.terrain', (t) => t.room === 'W10N5')[0].terrain = terrain;
      find(dump, 'rooms', (r) => r._id === 'W10N5')[0].powerBankTime = 1;
      const objects = docs(dump, 'rooms.objects');
      for (let y = 23; y <= 27; y++) {
        for (let x = 23; x <= 27; x++) {
          if (x === 23 || x === 27 || y === 23 || y === 27) {
            objects.push({
              _id: `ringdeposit${String(x)}x${String(y)}`,
              type: 'deposit',
              depositType: 'mist',
              room: 'W10N5',
              x,
              y,
              harvested: 0,
              decayTime: 100000,
            });
          }
        }
      }
    },
    steps: [cron('genPowerBanks')],
  },
  {
    name: 'maintenance.genInvaders',
    covers: ['cronjobs.genInvaders'],
    setup(dump, { C }) {
      docs(dump, 'rooms.objects').push({
        _id: 'fixturecore1',
        type: 'invaderCore',
        level: 2,
        room: 'W4N4',
        x: 25,
        y: 25,
        user: USERS.invader,
        hits: C.INVADER_CORE_HITS,
        hitsMax: C.INVADER_CORE_HITS,
      });
      setHarvested(dump, 'W2N2', C.INVADERS_ENERGY_GOAL);
      setHarvested(dump, 'W2N1', C.INVADERS_ENERGY_GOAL + 5);
      setHarvested(dump, 'W6N5', C.INVADERS_ENERGY_GOAL);
      setHarvested(dump, 'W1N1', 2000000);
      setHarvested(dump, 'W3N3', 10);
      find(dump, 'rooms', (r) => r._id === 'W8N8')[0].invaderGoal = 1;
      find(dump, 'rooms', (r) => r._id === 'W7N2')[0].invaderGoal = 500;
      setHarvested(dump, 'W7N2', 600);
      // big raid: an owned RCL 7 controller
      const controller = find(
        dump,
        'rooms.objects',
        (o) => o.room === 'W3N7' && o.type === 'controller',
      )[0];
      Object.assign(controller, { user: USERS.alice, level: 7 });
      setHarvested(dump, 'W3N7', C.INVADERS_ENERGY_GOAL);
    },
    steps: [
      cron('genInvaders', { before: (s) => setActiveRooms(s, []) }),
      cron('genInvaders'),
      cron('genInvaders', {
        before: async (s) => {
          await setActiveRooms(s, []);
          await s.oracle.db['rooms.objects'].removeWhere({ type: 'creep', user: '2' });
          for (const [id, o] of Object.entries(s.local.state.world.roomObjects)) {
            if (o.type === 'creep' && o.user === '2') delete s.local.state.world.roomObjects[id];
          }
        },
      }),
    ],
  },
  {
    name: 'maintenance.purgeTransactions',
    covers: ['cronjobs.purgeTransactions'],
    setup(dump) {
      const list = docs(dump, 'transactions');
      const users = [USERS.emma, USERS.alice, USERS.jack, USERS.michael];
      for (let i = 0; i < 420; i++) {
        list.push({
          _id: `fixturetx${String(i)}`,
          time: 1000 + Math.floor(i / 3),
          sender: users[i % 2],
          recipient: users[2 + (i % 3 === 0 ? 1 : 0)],
          resourceType: 'energy',
          amount: i,
          from: 'W1N1',
          to: 'W9N1',
        });
      }
    },
    steps: [cron('purgeTransactions'), cron('purgeTransactions')],
  },
  {
    name: 'maintenance.recreateNpcOrders',
    covers: ['cronjobs.recreateNpcOrders'],
    setup(dump) {
      const objects = docs(dump, 'rooms.objects');
      objects.push({
        _id: 'npcterminal1',
        type: 'terminal',
        room: 'W10N10',
        x: 20,
        y: 20,
        store: {},
      });
      objects.push({
        _id: 'npcterminal2',
        type: 'terminal',
        room: 'W0N10',
        x: 24,
        y: 24,
        user: null,
        store: {},
      });
      objects.push({
        _id: 'npcterminal3',
        type: 'terminal',
        room: 'W10N0',
        x: 25,
        y: 25,
        store: {},
      });
      objects.push({
        _id: 'ownterminal',
        type: 'terminal',
        room: 'W1N1',
        x: 30,
        y: 30,
        user: USERS.emma,
        store: {},
      });
      find(dump, 'rooms', (r) => r._id === 'W10N0')[0].status = 'out of borders';
      docs(dump, 'market.orders').push({
        _id: 'playerorder1',
        created: 1,
        active: true,
        type: 'sell',
        amount: 10,
        remainingAmount: 10,
        totalAmount: 10,
        resourceType: 'H',
        price: 5000,
        roomName: 'W10N10',
        user: USERS.emma,
      });
    },
    steps: [
      cron('recreateNpcOrders'),
      cron('recreateNpcOrders', { before: (s) => setGameTime(s, 3000) }),
      cron('recreateNpcOrders', { before: (s) => setGameTime(s, 7000), now: NOW + 10 * MINUTE }),
      cron('recreateNpcOrders', { before: (s) => setGameTime(s, 20000), now: NOW + 20 * MINUTE }),
    ],
  },
  {
    name: 'maintenance.calcMarketStats',
    covers: ['cronjobs.calcMarketStats'],
    setup(dump) {
      const money = docs(dump, 'users.money');
      const entries = [
        [1, 'H', 100, 2000],
        [1, 'H', 50, 2600],
        [1, 'energy', 1000, 10],
        [2, 'H', 10, 3000],
        [3, 'X', 7, 18000],
        [13, 'O', 300, 1500],
        [20, 'H', 100, 2000],
      ];
      entries.forEach(([daysAgo, resourceType, amount, price], i) => {
        money.push({
          _id: `fixturemoney${String(i)}`,
          date: new Date(NOW - daysAgo * DAY - i * MINUTE).toISOString(),
          tick: 100 + i,
          user: USERS.emma,
          type: 'market.sell',
          balance: 1000000,
          change: (amount * price) / 1000,
          market: {
            resourceType,
            roomName: 'W1N1',
            targetRoomName: 'W9N1',
            price: price / 1000,
            npc: false,
            owner: USERS.emma,
            dealer: USERS.jack,
            amount,
          },
        });
      });
      money.push({
        _id: 'fixturemoneybuy',
        date: new Date(NOW - DAY).toISOString(),
        tick: 120,
        user: USERS.jack,
        type: 'market.buy',
        balance: 0,
        change: -10,
        market: { resourceType: 'H', price: 1, amount: 10 },
      });
      docs(dump, 'market.stats').push({
        _id: 'stalestats',
        resourceType: 'Z',
        date: '2025-01-01',
        transactions: 1,
        volume: 1,
        avgPrice: 1,
        stddevPrice: 0,
      });
    },
    steps: [cron('calcMarketStats'), cron('calcMarketStats', { now: NOW + 13 * DAY })],
  },
  {
    name: 'maintenance.deletePowerCreeps',
    covers: ['cronjobs.deletePowerCreeps'],
    setup(dump) {
      const users = docs(dump, 'users');
      users.find((u) => u._id === USERS.emma).power = 25000000;
      users.find((u) => u._id === USERS.michael).power = 1500;
      users.find((u) => u._id === USERS.alice).power = 4000000;
      const creeps = docs(dump, 'users.power_creeps');
      creeps.push(powerCreep('pcexpired', USERS.emma, NOW - 1000));
      creeps.push(powerCreep('pclater', USERS.emma, NOW + 60 * MINUTE));
      creeps.push(powerCreep('pcnull', USERS.alice, null));
      creeps.push(powerCreep('pcmichael', USERS.michael, NOW - 5));
      creeps.push(powerCreep('pcalive', USERS.alice));
    },
    steps: [cron('deletePowerCreeps'), cron('deletePowerCreeps', { now: NOW + 2 * 60 * MINUTE })],
  },
  {
    name: 'maintenance.sendNotifications',
    covers: ['cronjobs.sendNotifications'],
    setup(dump) {
      const users = docs(dump, 'users');
      users.find((u) => u._id === USERS.emma).email = 'emma@example.test';
      Object.assign(
        users.find((u) => u._id === USERS.alice),
        { email: 'alice@example.test', notifyPrefs: { disabled: true } },
      );
      users.find((u) => u._id === USERS.jack).notifyPrefs = { interval: 5 };
      Object.assign(
        users.find((u) => u._id === USERS.michael),
        {
          email: 'michael@example.test',
          lastNotifyDate: NOW - 10 * MINUTE,
          notifyPrefs: { interval: 15 },
        },
      );
      const list = docs(dump, 'users.notifications');
      const add = (id, user, date, message) =>
        list.push({ _id: id, user, message, date, type: 'msg', count: 1 });
      add('n1', USERS.emma, NOW - MINUTE, 'one');
      add('n2', USERS.emma, NOW - 2 * MINUTE, 'two');
      add('n3', USERS.alice, NOW - MINUTE, 'three');
      add('n4', USERS.jack, NOW - MINUTE, 'four');
      add('n5', USERS.michael, NOW - MINUTE, 'five');
      add('n6', USERS.emma, NOW + MINUTE, 'later');
      add('n7', 'deletedUser', NOW - MINUTE, 'orphan');
    },
    steps: [
      sendNotifications(),
      { ...sendNotifications(), now: NOW + 2 * MINUTE },
      { ...sendNotifications(), now: NOW + 6 * MINUTE },
    ],
  },
  {
    name: 'maintenance.genDeposits',
    covers: ['cronjobs.genDeposits'],
    setup(dump) {
      find(dump, 'rooms.objects', (o) => o.type === 'deposit')[0].harvested = 100000;
      // a second sector center (two-digit name) next to the original world
      docs(dump, 'rooms').push({
        _id: 'W15N5',
        status: 'normal',
        sourceKeepers: false,
        bus: false,
      });
      const terrain = find(dump, 'rooms.terrain', (t) => t.room === 'W5N5')[0].terrain;
      docs(dump, 'rooms.terrain').push({ _id: 'fixtureterrainW15N5', room: 'W15N5', terrain });
    },
    steps: [
      cron('genDeposits'),
      cron('genDeposits'),
      cron('genDeposits', { before: (s) => setGameTime(s, 60000) }),
    ],
  },
  {
    name: 'maintenance.genStrongholds',
    covers: ['cronjobs.genStrongholds', 'strongholds.selectRoom', 'strongholds.spawnStronghold'],
    steps: [
      cron('genStrongholds'),
      cron('genStrongholds'),
      cron('genStrongholds', { before: (s) => setGameTime(s, 500) }),
    ],
  },
  {
    name: 'maintenance.expandStrongholds',
    covers: ['cronjobs.expandStrongholds', 'strongholds.expandStronghold'],
    setup(dump, { C }) {
      docs(dump, 'rooms.objects').push({
        _id: 'deployedcore',
        type: 'invaderCore',
        level: 2,
        room: 'W4N5',
        x: 25,
        y: 25,
        user: USERS.invader,
        hits: C.INVADER_CORE_HITS,
        hitsMax: C.INVADER_CORE_HITS,
        deployTime: null,
        nextExpandTime: 500,
        strongholdId: 'W4N5_1',
        templateName: 'bunker2',
        depositType: 'silicon',
        effects: [],
      });
      docs(dump, 'rooms.objects').push({
        _id: 'pendingcore',
        type: 'invaderCore',
        level: 3,
        room: 'W6N6',
        x: 20,
        y: 20,
        user: USERS.invader,
        hits: C.INVADER_CORE_HITS,
        hitsMax: C.INVADER_CORE_HITS,
        deployTime: 900,
        nextExpandTime: 10,
        strongholdId: 'W6N6_1',
        templateName: 'bunker3',
        depositType: 'metal',
      });
    },
    steps: [
      cron('expandStrongholds', { before: driverAccessibleRooms }),
      cron('expandStrongholds', { before: (s) => setGameTime(s, 1000) }),
      cron('expandStrongholds'),
      cron('expandStrongholds', { before: (s) => setGameTime(s, 5000) }),
    ],
  },
  {
    name: 'maintenance.unknownJob',
    covers: ['system.runCronjob'],
    steps: [cron('nope')],
  },
];
