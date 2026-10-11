import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  activateRoom,
  createConstants,
  createFlag,
  createGameState,
  GameError,
  GameSession,
  insertObject,
  worldConstants,
  type Constants,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;
const REPORT = `module.exports.loop = () => {
  Memory.creepLifeTime = CREEP_LIFE_TIME;
  Memory.flagsLimit = FLAGS_LIMIT;
};`;

const sessions: GameSession[] = [];
after(() => {
  for (const session of sessions) session.dispose();
});

/** Upstream example mod `change-constant.js` plus two more values read by game operations. */
function changedConstants(): Constants {
  const constants = createConstants();
  // `config.common.constants.CREEP_LIFE_TIME = 300` (the typed defaults are literal types).
  Object.assign(constants, { CREEP_LIFE_TIME: 300, SPAWN_ENERGY_START: 123, FLAGS_LIMIT: 0 });
  return constants;
}

function botWorld(constants?: Constants) {
  const state = createGameState({
    size: 2,
    seed: 5,
    shardName: 'shard0',
    ...(constants ? { constants } : {}),
  });
  const session = new GameSession({ state, now: () => NOW });
  sessions.push(session);
  const room = Object.values(state.world.roomObjects).find(
    (object) => object.type === 'controller',
  )?.room;
  assert.ok(room);
  const { userId } = session.spawnBot('probe', { main: REPORT }, room);
  const creep = insertObject(state.world, {
    type: 'creep',
    room,
    x: 25,
    y: 25,
    name: 'Newborn',
    user: userId,
    body: [{ type: 'move', hits: 100 }],
    store: {},
    storeCapacity: 0,
    hits: 100,
    hitsMax: 100,
    fatigue: 0,
    spawning: false,
    notifyWhenAttacked: true,
  });
  activateRoom(state.world, room);
  return { session, room, userId, creepId: creep._id };
}

void describe('per-world constants in game sessions', () => {
  void it('applies mod constants to one world while an independent world keeps defaults', async () => {
    const constants = changedConstants();
    const modded = botWorld(constants);
    const standard = botWorld();
    assert.equal(modded.session.constants, constants);
    assert.equal(worldConstants(modded.session.state.world), constants);
    assert.equal(standard.session.constants.CREEP_LIFE_TIME, 1500);

    const spawnEnergy = (world: typeof modded) =>
      Object.values(world.session.state.world.roomObjects).find(
        (object) => object.type === 'spawn' && object.user === world.userId,
      )?.store?.energy;
    assert.equal(spawnEnergy(modded), 123);
    assert.equal(spawnEnergy(standard), 300);

    const moddedStart = modded.session.state.world.gameTime;
    const standardStart = standard.session.state.world.gameTime;
    await Promise.all([modded.session.tick(), standard.session.tick()]);
    assert.equal(
      modded.session.state.world.roomObjects[modded.creepId]?.ageTime,
      moddedStart + 300,
    );
    assert.equal(
      standard.session.state.world.roomObjects[standard.creepId]?.ageTime,
      standardStart + 1500,
    );
    assert.deepEqual(JSON.parse(modded.session.runtime.getMemory(modded.userId)), {
      creepLifeTime: 300,
      flagsLimit: 0,
    });
    assert.deepEqual(JSON.parse(standard.session.runtime.getMemory(standard.userId)), {
      creepLifeTime: 1500,
      flagsLimit: 10000,
    });

    const flag = { x: 10, y: 10, name: 'Flag1', color: 1, secondaryColor: 1 };
    assert.throws(
      () => {
        createFlag(modded.session, modded.userId, { ...flag, room: modded.room });
      },
      (error: unknown) => error instanceof GameError && error.message === 'flags limit exceeded',
    );
    createFlag(standard.session, standard.userId, { ...flag, room: standard.room });
  });
});
