import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { WorldState } from '@openscreeps/engine';
import {
  activateRoom,
  createGameState,
  createPortalPair,
  GameSession,
  insertObject,
} from '../src/index.ts';
import { linkSectorCenters } from '../src/world/generate.ts';
import { assertPortalPair, portalTarget } from './portal-pairs.ts';

const NOW = 1_700_000_000_000;
// A centred world of 3 rooms per side: W1N1 is its controller room, the rest are highways.
const base = createGameState({ size: 3, seed: 5, shardName: 'shard0' });
const TRAVELLER = `module.exports.loop = () => {
  const creep = Game.creeps.Traveller;
  if (creep && !Memory.moved) Memory.moved = creep.move(RIGHT) === OK;
};`;

const sessions: GameSession[] = [];
after(() => {
  for (const session of sessions) session.dispose();
});

/** The wall in the middle of the portal cluster of `room`. */
function clusterCenter(world: WorldState, room: string): { x: number; y: number } {
  const portals = Object.values(world.roomObjects).filter(
    (object) => object.room === room && object.type === 'portal',
  );
  assert.equal(portals.length, 8);
  return {
    x: Math.min(...portals.map((portal) => portal.x)) + 1,
    y: Math.min(...portals.map((portal) => portal.y)) + 1,
  };
}

void describe('portals', () => {
  void it('links two rooms with a two-way pair whose portals point exactly back', () => {
    const world = structuredClone(base.world);
    createPortalPair(world, 'W1N1', 'E0S0', { unstableDate: NOW, decayTime: 100 });
    assertPortalPair(world, 'W1N1', 'E0S0', { unstableDate: NOW, decayTime: 100 });
    assert.ok(world.activeRooms.includes('W1N1') && world.activeRooms.includes('E0S0'));

    createPortalPair(world, 'W0N1', 'E0N1');
    assertPortalPair(world, 'W0N1', 'E0N1');
    assert.throws(() => {
      createPortalPair(world, 'W0N0', 'W0N0');
    }, /No free area/);
    assert.throws(() => {
      createPortalPair(world, 'W0N0', 'E9S9');
    }, /must exist/);
  });

  void it('pairs shuffled sector centers deterministically, one left out of an odd count', () => {
    const even = ['W1N1', 'W0N1', 'E0N1', 'W1S0'];
    const world = structuredClone(base.world);
    linkSectorCenters(world, even);
    for (const room of even) {
      const partner = portalTarget(world, room) as string;
      assert.ok(even.includes(partner) && partner !== room, room);
      assert.equal(portalTarget(world, partner), room);
      assertPortalPair(world, room, partner);
    }
    const again = structuredClone(base.world);
    linkSectorCenters(again, even);
    assert.deepEqual(again.roomObjects, world.roomObjects);
    assert.equal(again.rngState, world.rngState);

    const odd = ['W1N1', 'W0N1', 'E0N1'];
    const oddWorld = structuredClone(base.world);
    linkSectorCenters(oddWorld, odd);
    const alone = odd.filter((room) => portalTarget(oddWorld, room) === undefined);
    assert.equal(alone.length, 1);
    const [first, second] = odd.filter((room) => !alone.includes(room)) as [string, string];
    assertPortalPair(oddWorld, first, second);

    const single = structuredClone(base.world);
    linkSectorCenters(single, ['W1N1']);
    assert.deepEqual(single, base.world);
  });

  void it('moves a creep stepping onto a portal to its partner and back while it stays', async () => {
    const state = structuredClone(base);
    const session = new GameSession({ state, now: () => NOW });
    sessions.push(session);
    const { world } = state;
    const { userId } = session.spawnBot('traveller', { main: TRAVELLER }, 'W1N1');
    createPortalPair(world, 'W1N1', 'E0S0');
    const a = clusterCenter(world, 'W1N1');
    const b = clusterCenter(world, 'E0S0');
    const creep = insertObject(world, {
      type: 'creep',
      room: 'W1N1',
      x: a.x - 2,
      y: a.y,
      name: 'Traveller',
      user: userId,
      body: [{ type: 'move', hits: 100 }],
      store: {},
      storeCapacity: 0,
      hits: 100,
      hitsMax: 100,
      fatigue: 0,
      spawning: false,
      notifyWhenAttacked: true,
      ageTime: world.gameTime + 1500,
    });
    activateRoom(world, 'W1N1');
    const position = () => {
      const object = world.roomObjects[creep._id];
      return object && { room: object.room, x: object.x, y: object.y };
    };

    const positions = [];
    for (let tick = 0; tick < 4; tick++) {
      const result = await session.tick();
      assert.deepEqual(result.simulation.errors, []);
      positions.push(position());
    }
    // it steps right onto the west portal and lands on the partner portal, which sends it back
    const west = { room: 'W1N1', x: a.x - 1, y: a.y };
    const partner = { room: 'E0S0', x: b.x - 1, y: b.y };
    assert.deepEqual(positions, [partner, west, partner, west]);
  });
});
