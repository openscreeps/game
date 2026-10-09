import type { WorldState } from '@openscreeps/engine';

export type MarketOrder = WorldState['marketOrders'][string];
export type MarketStats = WorldState['marketStats'][string];

export interface MarketOrderIndexEntry {
  /** Resource type. */
  _id: string;
  count: number;
  buying: number;
  selling: number;
}

/**
 * HTTP-facing order: price converted from stored thousandths of a credit, processing scratch
 * fields dropped, and public owner IDs retained as in the pinned backend.
 */
function orderView(order: MarketOrder): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(order)) {
    if (key === '_id' || !key.startsWith('_')) {
      view[key] = value;
    }
  }
  view['price'] = order.price / 1000;
  return view;
}

/** Active order counts per resource type. */
export function marketOrderIndex(world: WorldState): MarketOrderIndexEntry[] {
  const list = new Map<string, MarketOrderIndexEntry>();
  for (const order of Object.values(world.marketOrders)) {
    const { active, resourceType, type } = order;
    if (!active) {
      continue;
    }
    let entry = list.get(resourceType);
    if (!entry) {
      entry = { _id: resourceType, count: 0, buying: 0, selling: 0 };
      list.set(resourceType, entry);
    }
    if (type === 'buy') {
      entry.buying++;
    }
    if (type === 'sell') {
      entry.selling++;
    }
    entry.count++;
  }
  return [...list.values()];
}

/**
 * Active orders of one resource as seen by a player; without a resource type every active order
 * (upstream queries `{resourceType: undefined}`, which LokiJS matches against any document).
 */
export function activeMarketOrders(
  world: WorldState,
  resourceType?: string,
): Array<Record<string, unknown>> {
  return Object.values(world.marketOrders)
    .filter(
      (order) =>
        order.active && (resourceType === undefined || order.resourceType === resourceType),
    )
    .map(orderView);
}

/** Every order (active or not) the user owns. */
export function userMarketOrders(
  world: WorldState,
  userId: string,
): Array<Record<string, unknown>> {
  return Object.values(world.marketOrders)
    .filter((order) => order.user === userId)
    .map(orderView);
}

/** Daily market statistics of one resource (every resource without one), newest first. */
export function marketHistory(world: WorldState, resourceType?: string): MarketStats[] {
  return Object.values(world.marketStats)
    .filter((stats) => resourceType === undefined || stats.resourceType === resourceType)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
