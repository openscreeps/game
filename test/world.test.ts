import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { BotRuntime, constants as C, type WorldState } from '@openscreeps/engine';
import {
  createPortalPair,
  createWorld,
  exitsOf,
  generateRoom,
  getUserWorldStatus,
  removeBot,
  removeRoom,
  roomNameFromXY,
  roomNameToXY,
  runJob,
  runMaintenance,
  spawnBot,
  spawnStronghold,
  worldBounds,
  worldSize,
  type GameContext,
  type GameState,
  type MaintenanceHooks,
  type NotificationRecipient,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;
const base = createWorld({ size: 11, seed: 7, shardName: 'shard0' });
const runtimes: BotRuntime[] = [];
after(() => {
  for (const runtime of runtimes) runtime.dispose();
});

function objectsIn(
  world: WorldState,
  room: string,
  type?: string,
): Array<WorldState['roomObjects'][string]> {
  return Object.values(world.roomObjects).filter(
    (o) => o.room === room && (type === undefined || o.type === type),
  );
}

function stateOf(world: WorldState = structuredClone(base)): GameState {
  const runtime = new BotRuntime({ now: () => NOW });
  runtimes.push(runtime);
  return {
    version: 1,
    world,
    runtime: runtime.snapshot(),
    branches: {},
    history: {},
    statistics: [],
    leaderboard: {},
    jobs: {},
    pendingIntents: {},
    pendingGlobalIntents: {},
  };
}

function contextOf(state: GameState): GameContext {
  const runtime = new BotRuntime({ now: () => NOW, snapshot: state.runtime });
  runtimes.push(runtime);
  return { state, runtime, now: () => NOW, terrainChanged: () => undefined };
}

const isWall = (terrain: string, x: number, y: number): boolean =>
  (Number(terrain.charAt(y * 50 + x)) & 1) > 0;

/** Every room name of the rectangle from the north-west room `from` to the south-east room `to`. */
function roomsBetween(from: string, to: string): string[] {
  const [minX, minY] = roomNameToXY(from);
  const [maxX, maxY] = roomNameToXY(to);
  const names: string[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) names.push(roomNameFromXY(x, y));
  }
  return names.sort();
}

/** The distance of a room name part (`W12`, `S3`) from the west/north sector highway. */
const offset = (part: string): number => Number(part.slice(1)) % 10;

function roomParts(name: string): [string, string] {
  const match = /^([WE]\d+)([NS]\d+)$/.exec(name);
  assert.ok(match, name);
  return [match[1] as string, match[2] as string];
}

void describe('world generation', () => {
  void it('is deterministic per seed', () => {
    const again = createWorld({ size: 11, seed: 7, shardName: 'shard0' });
    assert.deepEqual(again.terrain, base.terrain);
    assert.deepEqual(again.roomObjects, base.roomObjects);
    assert.deepEqual(again.rooms, base.rooms);
    const other = createWorld({ size: 3, seed: 8, shardName: 'shard0' });
    assert.notDeepEqual(other.terrain.W1N1, base.terrain.W1N1);
  });

  void it('centres worlds on the zero lines and reports their size like screeps.com', () => {
    const layouts: Array<[number, string, string, number]> = [
      // a lone W0N0: `calcWorldSize` starts its maxima at 0, counting the E0/S0 line
      [1, 'W0N0', 'W0N0', 2],
      [2, 'W0N0', 'E0S0', 2],
      [3, 'W1N1', 'E0S0', 3],
      [4, 'W1N1', 'E1S1', 4],
      [11, 'W5N5', 'E4S4', 11],
    ];
    for (const [size, from, to, reported] of layouts) {
      const world = size === 11 ? base : createWorld({ size, seed: 1, shardName: 'shard0' });
      assert.deepEqual(Object.keys(world.rooms).sort(), roomsBetween(from, to), String(size));
      assert.deepEqual(Object.keys(world.terrain).sort(), roomsBetween(from, to), String(size));
      assert.equal(worldSize(world), reported, String(size));
    }
    // Bounds of larger worlds (the 21-room default is generated in world-portals.test.ts).
    const corners = (size: number): [string, string] => {
      const { min, max } = worldBounds(size);
      return [roomNameFromXY(min, min), roomNameFromXY(max, max)];
    };
    assert.deepEqual(corners(21), ['W10N10', 'E9S9']);
    assert.deepEqual(corners(22), ['W10N10', 'E10S10']);
    assert.deepEqual(corners(62), ['W30N30', 'E30S30']);
    assert.deepEqual(corners(182), ['W90N90', 'E90S90']);
    assert.deepEqual(corners(199), ['W99N99', 'E98S98']);
    assert.throws(() => createWorld({ size: 0, seed: 1, shardName: 'shard0' }), /Invalid world/);
  });

  void it('lays out sectors around the zero lines: highways, keeper rooms, center, controllers, NPC terminals', () => {
    assert.equal(Object.keys(base.rooms).length, 121);
    assert.equal(base.users['2']?.username, 'Invader');
    assert.equal(base.users['3']?.username, 'Source Keeper');
    assert.ok(Object.values(base.users).some((u) => u.username === C.SYSTEM_USERNAME));

    const highways: string[] = [];
    const crossroads: string[] = [];
    const keepers: string[] = [];
    const controllers: string[] = [];
    for (const name of Object.keys(base.rooms)) {
      const [h, v] = roomParts(name);
      const highway = offset(h) === 0 || offset(v) === 0;
      const room = base.rooms[name];
      assert.ok(room);
      assert.equal(room.status, 'normal');
      assert.equal(base.terrain[name]?.length, 2500);
      if (highway) {
        highways.push(name);
        assert.equal(room.bus, true, name);
        assert.ok(room.depositType, name);
        const crossroad = offset(h) === 0 && offset(v) === 0;
        const objects = objectsIn(base, name);
        assert.equal(objects.length, crossroad ? 1 : 0, name);
        if (crossroad) {
          crossroads.push(name);
          assert.equal(objects[0]?.type, 'terminal');
          assert.equal(objects[0].user, undefined);
        }
      } else if ([4, 5, 6].includes(offset(h)) && [4, 5, 6].includes(offset(v))) {
        if (name !== 'W5N5') keepers.push(name);
      } else {
        controllers.push(name);
        assert.equal(objectsIn(base, name, 'controller').length, 1, name);
      }
    }
    // W0, E0, N0 and S0 cross at the centre of the world.
    assert.equal(highways.length, 4 * 11 - 4);
    assert.deepEqual(crossroads.sort(), ['E0N0', 'E0S0', 'W0N0', 'W0S0']);
    // Rooms of a highway segment between crossroads share a deposit type.
    for (const segment of [
      ['W0N1', 'W0N3', 'W0N5'],
      ['E1S0', 'E2S0', 'E4S0'],
      ['W5N0', 'W1N0'],
    ]) {
      assert.equal(new Set(segment.map((name) => base.rooms[name]?.depositType)).size, 1);
    }
    assert.equal(controllers.length, 121 - 40 - 9);

    // W5N5 is the only sector center inside the world; the keeper rooms of the W5N5, E5N5, W5S5
    // and E5S5 sectors reach in from the corners and edges.
    assert.equal(objectsIn(base, 'W5N5', 'controller').length, 0);
    assert.equal(objectsIn(base, 'W5N5', 'source').length, 3);
    assert.equal(objectsIn(base, 'W5N5', 'keeperLair').length, 0);
    assert.equal(objectsIn(base, 'W5N5', 'extractor').length, 1);
    assert.deepEqual(
      keepers.sort(),
      ['E4N4', 'E4N5', 'E4S4', 'W4N4', 'W4N5', 'W4S4', 'W5N4', 'W5S4'].sort(),
    );
    for (const name of keepers) {
      assert.equal(base.rooms[name]?.sourceKeepers, true, name);
      assert.equal(objectsIn(base, name, 'controller').length, 0, name);
      assert.equal(objectsIn(base, name, 'source').length, 3, name);
      const [mineral] = objectsIn(base, name, 'mineral');
      const [extractor] = objectsIn(base, name, 'extractor');
      assert.ok(mineral && extractor);
      assert.deepEqual([extractor.x, extractor.y], [mineral.x, mineral.y]);
      const lairs = objectsIn(base, name, 'keeperLair');
      // Source lairs can share a tile; bootstrap worlds also protect their mineral.
      for (const resource of [...objectsIn(base, name, 'source'), mineral]) {
        assert.ok(
          lairs.some(
            (lair) => Math.max(Math.abs(lair.x - resource.x), Math.abs(lair.y - resource.y)) <= 5,
          ),
          `${name}: ${resource.type} has a nearby keeper lair`,
        );
      }
    }
    for (const name of ['W2N2', 'E2S2', 'W3S1', 'E1N3']) {
      assert.ok(controllers.includes(name), name);
      const sources = objectsIn(base, name, 'source').length;
      assert.ok(sources >= 1 && sources <= 2, name);
      assert.equal(objectsIn(base, name, 'mineral').length, 1, name);
      for (const object of objectsIn(base, name)) {
        assert.ok(
          isWall(base.terrain[name] as string, object.x, object.y),
          `${name} ${object.type} sits in a wall`,
        );
      }
    }
  });

  void it('matches exits between neighbors, walls the border and keeps every open tile reachable', () => {
    for (const name of Object.keys(base.rooms)) {
      const [x, y] = roomNameToXY(name);
      const terrain = base.terrain[name] as string;
      const right = base.terrain[roomNameFromXY(x + 1, y)];
      const below = base.terrain[roomNameFromXY(x, y + 1)];
      if (right === undefined) assert.deepEqual(exitsOf(terrain, 'right'), [], name);
      else {
        assert.ok(exitsOf(terrain, 'right').length > 0, name);
        assert.deepEqual(exitsOf(terrain, 'right'), exitsOf(right, 'left'), name);
      }
      if (below === undefined) assert.deepEqual(exitsOf(terrain, 'bottom'), [], name);
      else {
        assert.ok(exitsOf(terrain, 'bottom').length > 0, name);
        assert.deepEqual(exitsOf(terrain, 'bottom'), exitsOf(below, 'top'), name);
      }
      if (base.terrain[roomNameFromXY(x - 1, y)] === undefined)
        assert.deepEqual(exitsOf(terrain, 'left'), []);
      if (base.terrain[roomNameFromXY(x, y - 1)] === undefined)
        assert.deepEqual(exitsOf(terrain, 'top'), []);
    }

    // world-wide flood fill over open tiles, crossing room edges like creeps do
    let open = 0;
    for (const terrain of Object.values(base.terrain)) {
      for (let i = 0; i < 2500; i++) if (!(Number(terrain.charAt(i)) & 1)) open++;
    }
    const startTerrain = base.terrain.W2N2 as string;
    const start = Array.from(startTerrain).findIndex((c) => !(Number(c) & 1));
    const seen = new Set<string>([`W2N2:${String(start)}`]);
    const queue: Array<[string, number, number]> = [['W2N2', start % 50, Math.floor(start / 50)]];
    while (queue.length) {
      const [room, x, y] = queue.pop() as [string, number, number];
      const [rx, ry] = roomNameToXY(room);
      const next: Array<[string, number, number]> = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if ((dx || dy) && x + dx >= 0 && x + dx <= 49 && y + dy >= 0 && y + dy <= 49)
            next.push([room, x + dx, y + dy]);
        }
      }
      if (x === 0) next.push([roomNameFromXY(rx - 1, ry), 49, y]);
      if (x === 49) next.push([roomNameFromXY(rx + 1, ry), 0, y]);
      if (y === 0) next.push([roomNameFromXY(rx, ry - 1), x, 49]);
      if (y === 49) next.push([roomNameFromXY(rx, ry + 1), x, 0]);
      for (const [nRoom, nx, ny] of next) {
        const terrain = base.terrain[nRoom];
        const key = `${nRoom}:${String(ny * 50 + nx)}`;
        if (terrain !== undefined && !isWall(terrain, nx, ny) && !seen.has(key)) {
          seen.add(key);
          queue.push([nRoom, nx, ny]);
        }
      }
    }
    assert.equal(seen.size, open);
  });

  void it('generates single rooms matching neighbors and removes them', () => {
    const world = structuredClone(base);
    assert.throws(() => {
      generateRoom(world, 'nowhere');
    }, /Invalid room name/);
    assert.throws(() => {
      generateRoom(world, 'W2N2');
    }, /already exists/);
    assert.throws(() => {
      generateRoom(world, 'W6N2', { exits: { right: [10, 11] } });
    }, /Exits in room W5N2 don't match/);
    generateRoom(world, 'W6N2');
    assert.deepEqual(
      exitsOf(world.terrain.W6N2 as string, 'right'),
      exitsOf(world.terrain.W5N2 as string, 'left'),
    );
    assert.equal(objectsIn(world, 'W6N2', 'controller').length, 1);

    generateRoom(world, 'E8S8', {
      sources: 2,
      mineral: 'X',
      controller: true,
      terrainType: 2,
      swampType: 3,
    });
    assert.equal(objectsIn(world, 'E8S8', 'source').length, 2);
    assert.equal(objectsIn(world, 'E8S8', 'mineral')[0]?.mineralType, 'X');
    // like upstream, a generated room waits for `roomsForceUpdate` to be scheduled
    assert.ok(!world.activeRooms.includes('E8S8'));

    removeRoom(world, 'E8S8');
    assert.equal(world.rooms.E8S8, undefined);
    assert.equal(world.terrain.E8S8, undefined);
    assert.equal(objectsIn(world, 'E8S8').length, 0);
    assert.throws(() => {
      removeRoom(world, 'E8S8');
    }, /not found/);

    createPortalPair(world, 'W2N2', 'E2S2', { decayTime: 100 });
    assert.equal(objectsIn(world, 'W2N2', 'portal').length, 8);
    assert.equal(objectsIn(world, 'E2S2', 'portal')[0]?.destination?.room, 'W2N2');
  });
});

void describe('maintenance jobs', () => {
  void it('runs on persisted wall-clock intervals without replaying after restart', () => {
    const state = stateOf();
    const all = runMaintenance(state, NOW);
    assert.equal(all.ran.length, 11);
    assert.deepEqual(all.errors, []);
    assert.deepEqual(runMaintenance(state, NOW + 1000).ran, []);
    assert.deepEqual(runMaintenance(state, NOW + 20_001).ran, ['roomsForceUpdate']);
    // a restored state keeps its schedule
    const restored: GameState = { ...state, jobs: structuredClone(state.jobs) };
    assert.deepEqual(runMaintenance(restored, NOW + 60_001).ran, [
      'sendNotifications',
      'roomsForceUpdate',
    ]);
    assert.throws(() => {
      runJob(state, 'nope', NOW);
    }, /Cronjob "nope" not found/);
  });

  void it('force-activates sleeping rooms except closed ones', () => {
    const state = stateOf();
    state.world.activeRooms = [];
    const closed = state.world.rooms.W2N2;
    assert.ok(closed);
    closed.status = 'out of borders';
    runJob(state, 'roomsForceUpdate', NOW);
    assert.equal(state.world.activeRooms.length, 120);
    assert.ok(!state.world.activeRooms.includes('W2N2'));
    const next = state.jobs['forceUpdate:W3N3'] as number;
    assert.ok(next >= state.world.gameTime + 90 && next < state.world.gameTime + 110);
    state.world.activeRooms = [];
    runJob(state, 'roomsForceUpdate', NOW);
    assert.deepEqual(state.world.activeRooms, []);
  });

  void it('schedules and spawns power banks in highway rooms', () => {
    const state = stateOf();
    const world = state.world;
    world.gameTime = 1000;
    runJob(state, 'genPowerBanks', NOW);
    const room = world.rooms.W0N5;
    assert.ok(room?.powerBankTime);
    assert.ok(room.powerBankTime >= 1000 + 37500 && room.powerBankTime <= 1000 + 62500);
    room.powerBankTime = 1000;
    world.activeRooms = [];
    runJob(state, 'genPowerBanks', NOW);
    const [bank] = objectsIn(world, 'W0N5', 'powerBank');
    assert.ok(bank);
    assert.equal(bank.hits, C.POWER_BANK_HITS);
    assert.equal(bank.decayTime, 1000 + C.POWER_BANK_DECAY);
    const power = bank.store?.power ?? 0;
    assert.ok(power >= C.POWER_BANK_CAPACITY_MIN && power < 2 * C.POWER_BANK_CAPACITY_MAX);
    assert.ok(isWall(world.terrain.W0N5 as string, bank.x, bank.y));
    assert.deepEqual(world.activeRooms, ['W0N5']);
  });

  void it('replenishes NPC terminal orders once per period', () => {
    const state = stateOf();
    runJob(state, 'recreateNpcOrders', NOW);
    const orders = Object.values(state.world.marketOrders);
    const rooms = new Set(orders.map((o) => o.roomName));
    assert.deepEqual([...rooms].sort(), ['E0N0', 'E0S0', 'W0N0', 'W0S0']);
    for (const order of orders) {
      assert.equal(order.user, undefined);
      assert.equal(order.active, true);
      assert.equal(order.createdTimestamp, NOW);
      assert.equal(order.remainingAmount, order.amount);
    }
    const sell = orders.find((o) => o.type === 'sell' && o.resourceType !== 'energy');
    assert.ok(sell);
    assert.equal(sell.amount, 200_000);
    const sellPrices: Record<string, number> = { H: 3000, O: 3000, X: 18000 };
    assert.equal(sell.price, sellPrices[sell.resourceType] ?? 6000);
    const ids = Object.keys(state.world.marketOrders).sort();
    runJob(state, 'recreateNpcOrders', NOW);
    assert.deepEqual(Object.keys(state.world.marketOrders).sort(), ids);
    state.world.gameTime = (state.jobs['npcOrders:W0N0'] as number) + 1;
    runJob(state, 'recreateNpcOrders', NOW);
    assert.notDeepEqual(Object.keys(state.world.marketOrders).sort(), ids);
  });

  void it('keeps the latest 100 transactions per sender and per recipient', () => {
    const state = stateOf();
    for (let i = 0; i < 150; i++) {
      const id = `t${String(i)}`;
      state.world.transactions[id] = {
        _id: id,
        time: i,
        sender: 'a',
        recipient: 'b',
        resourceType: 'H',
        amount: 1,
        from: 'W1N1',
        to: 'W2N2',
      };
    }
    state.world.transactions.unique = {
      _id: 'unique',
      time: 0,
      sender: 'a',
      recipient: 'c',
      resourceType: 'H',
      amount: 1,
      from: 'W1N1',
      to: 'W2N2',
    };
    runJob(state, 'purgeTransactions', NOW);
    const kept = Object.keys(state.world.transactions);
    assert.equal(kept.length, 101);
    assert.ok(kept.includes('unique'));
    assert.ok(kept.includes('t149') && kept.includes('t50') && !kept.includes('t49'));
  });

  void it('computes daily market statistics from the last 14 days of sales', () => {
    const state = stateOf();
    const sale = (
      id: string,
      date: number,
      amount: number,
      price: number,
      type = 'market.sell',
    ): void => {
      state.world.usersMoney[id] = {
        _id: id,
        date,
        tick: 1,
        user: 'u',
        type,
        balance: 0,
        change: amount * price,
        market: { resourceType: 'H', amount, price },
      };
    };
    sale('a', NOW - 1000, 10, 2);
    sale('b', NOW - 2000, 30, 4);
    sale('old', NOW - 15 * 24 * 3600 * 1000, 99, 99);
    sale('buy', NOW - 1000, 99, 99, 'market.buy');
    state.world.marketStats.stale = {
      _id: 'stale',
      resourceType: 'O',
      date: '2000-01-01',
      transactions: 1,
      volume: 1,
      avgPrice: 1,
      stddevPrice: 0,
    };
    runJob(state, 'calcMarketStats', NOW);
    const stats = Object.values(state.world.marketStats);
    assert.equal(stats.length, 1);
    const [stat] = stats;
    assert.ok(stat);
    assert.equal(stat.resourceType, 'H');
    assert.match(stat.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(stat.transactions, 2);
    assert.equal(stat.volume, 40);
    assert.equal(stat.avgPrice, 3.5);
    assert.equal(stat.stddevPrice, 0.866);
  });

  void it('deletes power creeps after their delete time and refunds one power level', () => {
    const state = stateOf();
    const world = state.world;
    world.users.p = { _id: 'p', username: 'P', power: 4000 };
    const creep = (id: string, deleteTime: number): void => {
      world.userPowerCreeps[id] = {
        _id: id,
        user: 'p',
        name: id,
        className: 'operator',
        level: 0,
        hitsMax: 1000,
        store: {},
        storeCapacity: 100,
        spawnCooldownTime: null,
        deleteTime,
        powers: {},
      };
    };
    creep('due', NOW - 1);
    creep('later', NOW + 1000);
    runJob(state, 'deletePowerCreeps', NOW);
    assert.deepEqual(Object.keys(world.userPowerCreeps), ['later']);
    assert.equal(world.users.p.power, 1000);
  });

  void it('batches notifications respecting host preferences and intervals', () => {
    const state = stateOf();
    const world = state.world;
    world.users.a = { _id: 'a', username: 'A' };
    world.users.b = { _id: 'b', username: 'B' };
    world.users.c = { _id: 'c', username: 'C' };
    const recipients: Record<string, NotificationRecipient> = {
      a: { email: 'a@example.com' },
      b: { email: 'b@example.com', preferences: { disabled: true } },
    };
    const hooks: MaintenanceHooks = { notificationRecipient: (userId) => recipients[userId] };
    const notify = (id: string, user: string, date: number): void => {
      world.notifications[id] = {
        _id: id,
        user,
        message: `msg ${id}`,
        date,
        type: 'msg',
        count: 2,
      };
    };
    notify('1', 'a', NOW - 10);
    notify('2', 'a', NOW - 5);
    notify('3', 'b', NOW - 5);
    notify('future', 'a', NOW + 10);
    const outbox = runJob(state, 'sendNotifications', NOW, hooks);
    assert.equal(outbox.length, 1);
    assert.deepEqual(
      { userId: outbox[0]?.userId, email: outbox[0]?.email, messages: outbox[0]?.messages },
      { userId: 'a', email: 'a@example.com', messages: ['msg 1\n[msg] (2)', 'msg 2\n[msg] (2)'] },
    );
    assert.deepEqual(outbox[0]?.notifications, [
      { message: 'msg 1', date: NOW - 10, count: 2, type: 'msg' },
      { message: 'msg 2', date: NOW - 5, count: 2, type: 'msg' },
    ]);
    assert.deepEqual(Object.keys(world.notifications), ['future']);
    // the default interval is 60 minutes
    assert.deepEqual(runJob(state, 'sendNotifications', NOW + 59 * 60_000, hooks), []);
    assert.equal(runJob(state, 'sendNotifications', NOW + 61 * 60_000, hooks).length, 1);
    // players without host account data still get hourly batches, without an address
    notify('4', 'c', NOW);
    const [anonymous, ...rest] = runJob(state, 'sendNotifications', NOW + 1);
    assert.deepEqual(rest, []);
    assert.equal(anonymous?.userId, 'c');
    assert.equal(anonymous.email, undefined);
  });

  void it('spawns strongholds, invader raids only in sectors with a core, and expands strongholds', () => {
    const state = stateOf();
    const world = state.world;
    world.gameTime = 100;
    const sources = objectsIn(world, 'W2N2', 'source');
    for (const source of sources) source.invaderHarvested = C.INVADERS_ENERGY_GOAL;
    world.activeRooms = [];
    runJob(state, 'genInvaders', NOW);
    assert.equal(Object.values(world.roomObjects).filter((o) => o.type === 'creep').length, 0);

    runJob(state, 'genStrongholds', NOW);
    const cores = Object.values(world.roomObjects).filter((o) => o.type === 'invaderCore');
    assert.equal(cores.length, 1);
    const [core] = cores;
    assert.ok(core);
    assert.ok(world.rooms[core.room]?.sourceKeepers, 'strongholds live in keeper rooms');
    assert.equal(core.deployTime, 100 + 5000);
    assert.equal(core.user, '2');
    assert.equal(core.strongholdId, `${core.room}_100`);
    assert.ok(
      Object.values(world.roomObjects).some(
        (o) => o.type === 'rampart' && o.strongholdId === core.strongholdId,
      ),
    );
    runJob(state, 'genStrongholds', NOW);
    assert.equal(
      Object.values(world.roomObjects).filter((o) => o.type === 'invaderCore').length,
      1,
    );

    world.activeRooms = [];
    runJob(state, 'genInvaders', NOW);
    const invaders = objectsIn(world, 'W2N2', 'creep');
    assert.ok(invaders.length >= 1);
    for (const invader of invaders) {
      assert.equal(invader.user, '2');
      assert.ok(invader.x === 0 || invader.x === 49 || invader.y === 0 || invader.y === 49);
      assert.match(invader.name ?? '', /^invader_W2N2_\d+$/);
    }
    assert.ok(sources.every((s) => s.invaderHarvested === 0));
    assert.ok(world.activeRooms.includes('W2N2'));

    core.deployTime = null;
    core.nextExpandTime = 50;
    runJob(state, 'expandStrongholds', NOW);
    const lesser = Object.values(world.roomObjects).filter(
      (o) => o.type === 'invaderCore' && o.level === 0,
    );
    assert.equal(lesser.length, 1);
    assert.equal(lesser[0]?.strongholdId, core.strongholdId);
    assert.equal(objectsIn(world, lesser[0].room, 'controller').length, 1);
    const expansionDelay = (C.INVADER_CORE_EXPAND_TIME as Record<number, number>)[core.level ?? 1];
    assert.ok(expansionDelay !== undefined);
    assert.equal(core.nextExpandTime, 100 + expansionDelay);

    assert.throws(() => {
      spawnStronghold(world, 'W5N5', { templateName: 'nope' });
    }, /invalid template/);
  });

  void it('generates deposits in free highway rooms of the sector', () => {
    const state = stateOf();
    state.world.gameTime = 10;
    runJob(state, 'genDeposits', NOW);
    const deposits = Object.values(state.world.roomObjects).filter((o) => o.type === 'deposit');
    assert.equal(deposits.length, 1);
    const [deposit] = deposits;
    assert.ok(deposit);
    assert.equal(deposit.depositType, state.world.rooms[deposit.room]?.depositType);
    assert.equal(deposit.decayTime, 10 + C.DEPOSIT_DECAY_TIME);
    assert.ok(state.world.rooms[deposit.room]?.bus);
  });
});

void describe('bot players', () => {
  void it('spawns, reports status and removes a bot leaving ruins', () => {
    const state = stateOf();
    const context = contextOf(state);
    const { userId, username } = spawnBot(
      context,
      'simplebot',
      { main: 'module.exports.loop = function () {};' },
      'W2N2',
      { gcl: 2 },
    );
    assert.match(username, /^[A-Za-z]+Bot$/);
    const user = state.world.users[userId];
    assert.equal(user?.bot, 'simplebot');
    assert.equal(user.gcl, C.GCL_MULTIPLY);
    const [controller] = objectsIn(state.world, 'W2N2', 'controller');
    assert.equal(controller?.user, userId);
    assert.equal(controller.level, 1);
    const [spawn] = objectsIn(state.world, 'W2N2', 'spawn');
    assert.ok(spawn && !isWall(state.world.terrain.W2N2 as string, spawn.x, spawn.y));
    assert.equal(getUserWorldStatus(state.world, userId), 'normal');
    assert.throws(() => {
      spawnBot(context, 'simplebot', {}, 'W2N2');
    }, /already owned/);

    removeBot(context, username);
    assert.equal(state.world.users[userId], undefined);
    assert.equal(controller.user, null);
    assert.equal(controller.level, 0);
    const [ruin] = objectsIn(state.world, 'W2N2', 'ruin');
    assert.equal(ruin?.structure?.type, 'spawn');
    assert.equal(state.world.users[ruin.user as string]?.username, C.SYSTEM_USERNAME);
    assert.ok(Object.values(state.branches).every((branch) => branch.user !== userId));
    assert.throws(() => {
      removeBot(context, username);
    }, /User not found/);
  });
});
