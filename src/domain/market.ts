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
 * Player view of a stored order: price converted from the stored thousandths of a credit,
 * processing scratch fields (`_skip`, `_cancelled`) dropped, and the owner hidden on other
 * players' orders.
 */
function orderView(order: MarketOrder, viewerId: string): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(order)) {
    if (key === '_id' || !key.startsWith('_')) {
      view[key] = value;
    }
  }
  view['price'] = order.price / 1000;
  if (order.user !== viewerId) {
    delete view['user'];
  }
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

/** Active orders of one resource as seen by a player. */
export function activeMarketOrders(
  world: WorldState,
  viewerId: string,
  resourceType?: string,
): Array<Record<string, unknown>> {
  return Object.values(world.marketOrders)
    .filter((order) => order.active && order.resourceType === resourceType)
    .map((order) => orderView(order, viewerId));
}

/** Every order (active or not) the user owns. */
export function userMarketOrders(
  world: WorldState,
  userId: string,
): Array<Record<string, unknown>> {
  return Object.values(world.marketOrders)
    .filter((order) => order.user === userId)
    .map((order) => orderView(order, userId));
}

/** Daily market statistics of one resource, newest first. */
export function marketHistory(world: WorldState, resourceType?: string): MarketStats[] {
  return Object.values(world.marketStats)
    .filter((stats) => stats.resourceType === resourceType)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
