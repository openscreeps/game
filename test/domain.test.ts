import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BotRuntime, createWorldState } from '@openscreeps/engine';
import {
  addGlobalIntent,
  addObjectIntent,
  activeMarketOrders,
  createConstructionSite,
  createFlag,
  createPowerCreep,
  GameError,
  GameSession,
  listPowerCreeps,
  mapStats,
  placeSpawn,
  uniqueFlagName,
  userFlags,
  type GameOperationContext,
  type GameState,
} from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 8, 12, 3, 30);

/** Room terrain with natural walls on every border tile. */
function terrain(): string {
  let result = '';
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      result += x % 49 === 0 || y % 49 === 0 ? '1' : '0';
    }
  }
  return result;
}

/** A plain game state and clock: no session, host or HTTP request involved. */
function game(): GameOperationContext {
  const runtime = new BotRuntime({ now: () => NOW });
  let snapshot: GameState['runtime'];
  try {
    snapshot = runtime.snapshot();
  } finally {
    runtime.dispose();
  }
  const state: GameState = {
    version: 1,
    world: createWorldState({
      gameTime: 100,
      rooms: { W1N1: { _id: 'W1N1', status: 'normal' } },
      terrain: { W1N1: terrain() },
      users: {
        alice: { _id: 'alice', username: 'Alice', usernameLower: 'alice', cpu: 100, gcl: 0 },
      },
      roomObjects: {
        c1: { _id: 'c1', type: 'controller', room: 'W1N1', x: 5, y: 5, level: 0 },
      },
    }),
    runtime: snapshot,
    branches: {},
    history: {},
    statistics: [],
    leaderboard: {},
    jobs: {},
    pendingIntents: {},
    pendingGlobalIntents: {},
  };
  return { state, now: () => NOW };
}

function rejects(operation: () => unknown, message: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof GameError, String(error));
    assert.equal(error.message, message);
    return true;
  });
}

void describe('gameplay operations', () => {
  void it('lets a player start, build, flag and queue intents with plain inputs', () => {
    const context = game();
    const { world } = context.state;
    const spawn = placeSpawn(context, 'alice', { room: 'W1N1', x: 25, y: 25, name: 'Spawn1' });
    assert.equal(world.roomObjects[spawn._id]?.user, 'alice');
    assert.equal(world.roomObjects['c1']?.user, 'alice');
    rejects(
      () => placeSpawn(context, 'alice', { room: 'W1N1', x: 26, y: 26, name: 'Spawn2' }),
      'already playing',
    );

    const site = createConstructionSite(context, 'alice', {
      room: 'W1N1',
      x: 27,
      y: 25,
      structureType: 'road',
    });
    assert.equal(world.roomObjects[site._id]?.type, 'constructionSite');
    assert.ok(world.activeRooms.includes('W1N1'));

    createFlag(context, 'alice', {
      room: 'W1N1',
      x: 10,
      y: 11,
      name: 'Flag1',
      color: 1,
      secondaryColor: 2,
    });
    assert.deepEqual(userFlags(world, 'alice').get('W1N1'), [['Flag1', '1', '2', '10', '11']]);
    assert.equal(uniqueFlagName(world, 'alice'), 'Flag2');

    addObjectIntent(context, 'alice', {
      room: 'W1N1',
      targetId: site._id,
      name: 'remove',
      intent: {},
    });
    assert.deepEqual(context.state.pendingIntents['W1N1']?.['alice']?.[site._id], { remove: {} });
    addGlobalIntent(context.state, 'alice', {
      name: 'cancelOrder',
      intent: { orderId: 'order1' },
    });
    assert.equal(context.state.pendingGlobalIntents['alice']?.['cancelOrder']?.length, 1);
  });

  void it('keeps validation precedence and rejects with GameError', () => {
    const context = game();
    const alice = context.state.world.users['alice'];
    assert.ok(alice);
    alice.blocked = true;
    rejects(() => placeSpawn(context, 'alice', { room: 'W1N1', x: 50, y: 25 }), 'invalid params');
    rejects(
      () => placeSpawn(context, 'alice', { room: 'W1N1', x: 25, y: 25, name: 'Spawn1' }),
      'blocked',
    );
    rejects(() => {
      addObjectIntent(context, 'alice', { room: 'W9N9', name: 'remove', intent: {} });
    }, 'invalid room');
    rejects(
      () => mapStats(context.state, NOW, { rooms: ['W1N1'], statName: 'owner' }),
      'invalid params',
    );
  });

  void it('manages power creeps and market views per player', () => {
    const context = game();
    const { world } = context.state;
    rejects(
      () => createPowerCreep(context.state, 'alice', { className: 'operator', name: 'Op' }),
      'not enough power level',
    );
    const alice = world.users['alice'];
    assert.ok(alice);
    alice.power = 1_000_000;
    const creep = createPowerCreep(context.state, 'alice', { className: 'operator', name: 'Op' });
    assert.deepEqual(
      listPowerCreeps(world, 'alice').map((item) => item._id),
      [creep._id],
    );

    world.marketOrders['o1'] = {
      _id: 'o1',
      created: 1,
      active: true,
      type: 'sell',
      resourceType: 'energy',
      user: 'bob',
      price: 1500,
      amount: 10,
      remainingAmount: 10,
      totalAmount: 10,
      roomName: 'W1N1',
    };
    const [order] = activeMarketOrders(world, 'alice', 'energy');
    assert.equal(order?.['price'], 1.5);
    assert.equal('user' in order, false);
  });
});

void describe('gameplay operations on a session', () => {
  void it('applies a player action queued between ticks', async () => {
    const session = new GameSession({ state: game().state, now: () => NOW });
    try {
      const player = session.createPlayer({ username: 'Carol' });
      placeSpawn(session, player._id, { room: 'W1N1', x: 25, y: 25, name: 'Spawn1' });
      const site = createConstructionSite(session, player._id, {
        room: 'W1N1',
        x: 27,
        y: 25,
        structureType: 'road',
      });
      addObjectIntent(session, player._id, {
        room: 'W1N1',
        targetId: 'room',
        name: 'removeConstructionSite',
        intent: [{ roomName: 'W1N1', id: site._id }],
      });
      await session.tick();
      assert.equal(session.state.world.roomObjects[site._id], undefined);
      assert.deepEqual(session.state.pendingIntents, {});
    } finally {
      session.dispose();
    }
  });
});
