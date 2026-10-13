import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { WorldState } from '@openscreeps/engine';
import { createWorld } from '../src/index.ts';

function objectsIn(world: WorldState, room: string, type?: string) {
  return Object.values(world.roomObjects).filter(
    (object) => object.room === room && (type === undefined || object.type === type),
  );
}

const isWall = (terrain: string, x: number, y: number): boolean =>
  (Number(terrain.charAt(y * 50 + x)) & 1) > 0;

// A separate test process runs the full four-sector world alongside the other generation tests.
void it('links sector centers with portals landing next to the paired cluster', () => {
  const world = createWorld({ size: 21, seed: 3, shardName: 'shard0' });
  const centers = ['W5N5', 'W15N5', 'W5N15', 'W15N15'];
  for (const center of centers) {
    const portals = objectsIn(world, center, 'portal');
    assert.equal(portals.length, 8, center);
    assert.equal(objectsIn(world, center, 'constructedWall').length, 1);
    const target = portals[0]?.destination?.room as string;
    assert.ok(centers.includes(target) && target !== center);
    for (const portal of portals) {
      const destination = portal.destination;
      assert.ok(destination);
      assert.equal(destination.room, target);
      assert.ok(!isWall(world.terrain[target] as string, destination.x, destination.y));
      assert.equal(
        objectsIn(world, target).filter(
          (object) => object.x === destination.x && object.y === destination.y,
        ).length,
        0,
      );
    }
  }
});
