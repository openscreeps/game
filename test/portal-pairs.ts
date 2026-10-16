import assert from 'node:assert/strict';
import type { WorldState } from '@openscreeps/engine';
import type { PortalOptions } from '../src/index.ts';

/** The portal room every portal of `room` leads to (`undefined` without portals). */
export function portalTarget(world: WorldState, room: string): string | undefined {
  return Object.values(world.roomObjects).find(
    (object) => object.room === room && object.type === 'portal',
  )?.destination?.room;
}

/**
 * Assert that `a` and `b` are linked like screeps.com's portal pairs: one cluster of eight portals
 * around a wall in each room, every portal leading to the matching portal tile of the other room,
 * which leads exactly back, all carrying `options`.
 */
export function assertPortalPair(
  world: WorldState,
  a: string,
  b: string,
  options: PortalOptions = {},
): void {
  const objects = Object.values(world.roomObjects);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const portals = objects.filter((object) => object.room === from && object.type === 'portal');
    assert.equal(portals.length, 8, from);
    const center = objects.filter(
      (object) =>
        object.room === from &&
        object.type === 'constructedWall' &&
        portals.every(
          (portal) => Math.max(Math.abs(portal.x - object.x), Math.abs(portal.y - object.y)) === 1,
        ),
    );
    assert.equal(center.length, 1, from);
    for (const portal of portals) {
      const destination = portal.destination;
      assert.equal(destination?.room, to, from);
      const partners = objects.filter(
        (object) => object.room === to && object.x === destination.x && object.y === destination.y,
      );
      assert.equal(partners.length, 1, `${from} ${String(portal.x)},${String(portal.y)}`);
      const [partner] = partners;
      assert.equal(partner?.type, 'portal');
      assert.deepEqual(partner.destination, { room: from, x: portal.x, y: portal.y });
      assert.equal(portal.unstableDate, options.unstableDate);
      assert.equal(portal.decayTime, options.decayTime);
    }
  }
}
