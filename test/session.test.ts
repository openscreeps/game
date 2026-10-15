import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  createGameState,
  GameSession,
  gameStateOf,
  MAINTENANCE_JOBS,
  parseGameState,
  type GameState,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;
const PROBE = `module.exports.loop = () => {
  global.runs = (global.runs || 0) + 1;
  Memory.runs = global.runs;
  Memory.tile = Game.map.getRoomTerrain(Memory.room).get(1, 1);
};`;

/** A world with private host data stored next to the game fields, as servers do. */
type HostState = GameState & { secrets: Record<string, string> };

// Generation is covered by world.test.ts; each session gets an independent raw state clone. A
// centred world of 3 rooms per side has one controller room, W1N1 (the rest are highways).
const generatedState = createGameState({ size: 3, seed: 5, shardName: 'shard0' });

const sessions: Array<GameSession<HostState>> = [];
after(() => {
  for (const session of sessions) session.dispose();
});

function world(): { session: GameSession<HostState>; room: string; userId: string } {
  const state: HostState = {
    ...structuredClone(generatedState),
    secrets: { alice: 'password-hash' },
  };
  const session = new GameSession({ state, now: () => NOW, historyTicks: 2, historyChunkSize: 1 });
  sessions.push(session);
  const room = Object.values(state.world.roomObjects).find(
    (object) => object.type === 'controller',
  )?.room;
  assert.ok(room);
  const { userId } = session.spawnBot('probe', { main: PROBE }, room);
  session.runtime.setMemory(userId, JSON.stringify({ room }));
  return { session, room, userId };
}

function memory(session: GameSession<HostState>, userId: string): Record<string, unknown> {
  return JSON.parse(session.runtime.getMemory(userId)) as Record<string, unknown>;
}

void describe('game session', () => {
  void it('runs a generated world with player code, NPC maintenance and records', async () => {
    const { session, room, userId } = world();
    const start = session.state.world.gameTime;
    const first = await session.tick();
    assert.deepEqual(first.maintenance.ran, Object.keys(MAINTENANCE_JOBS));
    assert.deepEqual(first.maintenance.errors, []);
    assert.deepEqual(first.simulation.errors, []);
    assert.equal(first.timestamp, NOW);
    assert.ok(first.runtime.users[userId]);
    const second = await session.tick();
    assert.deepEqual(second.maintenance.ran, []);
    assert.equal(session.state.world.gameTime, start + 2);
    assert.deepEqual(memory(session, userId), {
      room,
      runs: 2,
      tile: Number(session.state.world.terrain[room]?.charAt(51)),
    });
    assert.equal(session.state.statistics.length, 1);
    assert.equal(session.state.statistics[0]?.ticks, 2);
    assert.ok(session.state.jobs['cron:sendNotifications']);
    assert.ok(session.state.history[room]?.length);
  });

  void it('leaves maintenance to hosts that schedule it and passes simulation hooks', async () => {
    const state = structuredClone(generatedState);
    const rooms = new Set<string>();
    const session = new GameSession({
      state,
      now: () => NOW,
      maintenance: false,
      simulation: {
        hooks: {
          processRoom: (scope) => {
            rooms.add(scope.roomName);
          },
        },
      },
    });
    try {
      const room = Object.values(state.world.roomObjects).find(
        (object) => object.type === 'controller',
      )?.room;
      assert.ok(room);
      session.spawnBot('probe', { main: PROBE }, room);
      const tick = await session.tick();
      assert.deepEqual(tick.maintenance, { ran: [], errors: [], notifications: [] });
      assert.equal(state.jobs['cron:sendNotifications'], undefined);
      assert.ok(tick.simulation.processedRooms.includes(room));
      assert.ok(rooms.has(room));
    } finally {
      session.dispose();
    }
  });

  void it('rejects state operations while a tick is in flight', async () => {
    const { session } = world();
    const pending = session.tick();
    assert.equal(session.ticking, true);
    assert.throws(() => session.createPlayer({ username: 'late' }), /tick is running/);
    assert.throws(() => session.snapshot(), /tick is running/);
    await assert.rejects(session.tick(), /tick is running/);
    await pending;
    assert.equal(session.ticking, false);
    assert.equal(session.createPlayer({ username: 'late' }).username, 'late');
  });

  void it('manages players and their code', () => {
    const { session } = world();
    const alice = session.createPlayer({ username: 'alice' });
    assert.throws(() => session.createPlayer({ username: 'ALICE' }), /username already exists/);
    const branch = session.saveCode(alice._id, { main: 'module.exports.loop = () => {};' });
    assert.equal(branch.branch, 'default');
    assert.deepEqual(session.runtime.getCode(alice._id)?.modules, branch.modules);
    session.removePlayer(alice._id);
    assert.equal(session.state.world.users[alice._id], undefined);
    assert.equal(session.runtime.getCode(alice._id), undefined);
    assert.ok(Object.values(session.state.branches).every((entry) => entry.user !== alice._id));
  });

  void it('snapshots isolated, credential-free game state', async () => {
    const { session, userId } = world();
    await session.tick();
    const snapshot = session.snapshot();
    assert.equal('secrets' in snapshot, false);
    assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(gameStateOf(session.state)).sort());
    assert.deepEqual(snapshot.runtime, session.runtime.snapshot());
    const decoded: unknown = JSON.parse(JSON.stringify(snapshot));
    assert.equal(parseGameState(decoded), decoded);

    const gameTime = snapshot.world.gameTime;
    snapshot.world.gameTime = -1;
    Reflect.deleteProperty(snapshot.world.users, userId);
    assert.equal(session.state.world.gameTime, gameTime);
    assert.ok(session.state.world.users[userId]);
    await session.tick();
    assert.equal(snapshot.world.gameTime, -1);
  });

  void it('restores snapshots with a fresh runtime while keeping host records', async () => {
    const { session, userId } = world();
    await session.tick();
    const saved = session.snapshot();
    await session.tick();
    await session.tick();
    assert.equal(memory(session, userId).runs, 3);
    session.state.secrets.bob = 'other-hash';

    session.restore(saved);
    assert.equal(session.state.world.gameTime, saved.world.gameTime);
    assert.deepEqual(session.state.secrets, { alice: 'password-hash', bob: 'other-hash' });
    assert.equal(memory(session, userId).runs, 1);
    await session.tick();
    // the restored runtime starts new isolates: the heap counter restarts
    assert.equal(memory(session, userId).runs, 1);
    saved.world.gameTime = -1;
    assert.notEqual(session.state.world.gameTime, -1);
  });

  void it('refreshes player terrain after changes, also across preserved adoption', async () => {
    const { session, room, userId } = world();
    await session.tick();
    const terrain = session.state.world.terrain[room];
    assert.ok(terrain);
    const changed = (Number(terrain.charAt(51)) + 1) % 4;
    session.state.world.terrain[room] = terrain.slice(0, 51) + String(changed) + terrain.slice(52);
    session.terrainChanged();
    assert.equal(session.terrainDirty, true);

    // a host reinstating its committed state keeps heaps and the pending terrain refresh
    session.syncRuntime();
    const committed = structuredClone(session.state);
    session.adopt(committed, { runtime: 'preserve', terrainDirty: session.terrainDirty });
    assert.equal(session.state, committed);
    const tick = await session.tick();
    assert.deepEqual(tick.simulation.errors, []);
    assert.equal(session.terrainDirty, false);
    assert.equal(memory(session, userId).runs, 2);
    assert.equal(memory(session, userId).tile, changed);

    // a runtime that differs from the adopted state restarts even when preserving
    const stale = structuredClone(committed);
    session.adopt(stale, { runtime: 'preserve' });
    await session.tick();
    assert.equal(memory(session, userId).runs, 1);
  });

  void it('rejects malformed snapshots before they can be restored', () => {
    const { session } = world();
    const snapshot = session.snapshot();
    const malformed: unknown[] = [
      null,
      { ...snapshot, version: 2 },
      { ...snapshot, history: { room: [{ time: 1, objects: null }] } },
      { ...snapshot, branches: { broken: {} } },
      { ...snapshot, runtime: { ...snapshot.runtime, users: { broken: {} } } },
      { ...snapshot, statistics: [{ time: 1, tick: 1, ticks: 1, rooms: null, users: {} }] },
      { ...snapshot, world: { ...snapshot.world, terrain: { W1N1: 'x' } } },
    ];
    for (const value of malformed) {
      assert.throws(() => parseGameState(value), /Invalid|Unsupported/);
    }
  });

  void it('rejects use after disposal', async () => {
    const state = createGameState({ size: 1, seed: 1, shardName: 'shard0' });
    const session = new GameSession({ state });
    session.dispose();
    session.dispose();
    await assert.rejects(session.tick(), /disposed/);
    assert.throws(() => session.snapshot(), /disposed/);
  });
});
