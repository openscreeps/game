import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { WorldState } from '@openscreeps/engine';
import { createWorld, roomNameFromXY, worldSize } from '../src/index.ts';
import { assertPortalPair, portalTarget } from './portal-pairs.ts';

function objectsIn(world: WorldState, room: string, type?: string) {
  return Object.values(world.roomObjects).filter(
    (object) => object.room === room && (type === undefined || object.type === type),
  );
}

// A separate test process runs the full four-sector world alongside the other generation tests.
void it('centres the default 21-room world and links its sector centers in portal pairs', () => {
  const world = createWorld({ size: 21, seed: 3, shardName: 'shard0' });
  // W10N10..E9S9: the W0/E0 and N0/S0 highways cross in the middle, W10 and N10 border the
  // west and north; the E10/S10 highways lie just outside.
  const expected: string[] = [];
  for (let y = -11; y <= 9; y++) {
    for (let x = -11; x <= 9; x++) expected.push(roomNameFromXY(x, y));
  }
  assert.deepEqual(Object.keys(world.rooms).sort(), expected.sort());
  assert.equal(worldSize(world), 21);
  const crossroads = Object.values(world.roomObjects)
    .filter((object) => object.type === 'terminal')
    .map((object) => object.room)
    .sort();
  assert.deepEqual(
    crossroads,
    ['E0N0', 'E0N10', 'E0S0', 'W0N0', 'W0N10', 'W0S0', 'W10N0', 'W10N10', 'W10S0'].sort(),
  );
  for (const room of ['W10N3', 'E3N10', 'E0S9', 'W7S0']) {
    assert.equal(world.rooms[room]?.bus, true, room);
  }
  for (const room of ['E9S9', 'E9N1', 'W1S9']) {
    assert.equal(objectsIn(world, room, 'controller').length, 1, room);
  }

  // four centers: two shuffled two-way pairs of permanent portals, as on screeps.com
  const centers = ['W5N5', 'E5N5', 'W5S5', 'E5S5'];
  const partners = centers.map((center) => portalTarget(world, center));
  for (const [i, center] of centers.entries()) {
    const partner = partners[i] as string;
    assert.ok(centers.includes(partner) && partner !== center, center);
    assert.equal(portalTarget(world, partner), center);
    assertPortalPair(world, center, partner);
  }
  // seed 3 pairs the two western and the two eastern centers
  assert.deepEqual(partners, ['W5S5', 'E5S5', 'W5N5', 'E5N5']);
});
