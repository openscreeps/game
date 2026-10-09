/*
 * Shared scenario inputs. These only write the same raw values to both sides; no backend rule is
 * re-implemented here except the driver-owned `accessibleRooms` list, which the backend reads but
 * the driver writes (see `driverAccessibleRooms`).
 */

export const USERS = {
  invader: '2',
  keeper: '3',
  system: 'f4b532d08c3952a',
  michael: 'a1123272b261687', // W9N9
  emma: '17c332744f825c7', // W1N1
  alice: 'e3b732c504eb83a', // W1N9
  jack: 'eea532c5a2f9e44', // W9N1
};

export const DAY = 24 * 3600 * 1000;

export function docs(dump, name) {
  return (dump.collections[name] ??= []);
}

export function find(dump, name, predicate) {
  return docs(dump, name).filter(predicate);
}

export function env(dump) {
  return dump.env[0].data;
}

export async function setGameTime({ oracle, local }, time) {
  await oracle.env.set(oracle.env.keys.GAMETIME, time);
  local.state.world.gameTime = time;
}

export async function setActiveRooms({ oracle, local }, rooms) {
  await oracle.env.set(oracle.env.keys.ACTIVE_ROOMS, [...rooms]);
  local.state.world.activeRooms = [...rooms];
}

/**
 * Inputs the server/driver maintain and `buildMapGrid` reads: the terrain cache through the
 * original `map.updateTerrainData`, and `accessibleRooms` written exactly like driver
 * `lib/index.js` `updateAccessibleRoomsList` (cf63d8a): rooms with status `normal` whose `openTime`
 * is unset or in the past.
 */
export async function driverAccessibleRooms({ oracle }) {
  const rooms = await oracle.db.rooms.find({ status: 'normal' });
  const list = rooms.filter((i) => !i.openTime || i.openTime < Date.now()).map((i) => i._id);
  await oracle.env.set(oracle.env.keys.ACCESSIBLE_ROOMS, JSON.stringify(list));
  await oracle.modules.map.updateTerrainData();
}

/** `system.runCronjob(name)` upstream vs `runJob` locally. */
export function cron(name, { before, now, result } = {}) {
  return {
    op: `system.runCronjob(${JSON.stringify(name)})`,
    now,
    before,
    upstream: (o) => o.modules.system.runCronjob(name),
    local: (l, game) => game.runJob(l.state, name, l.context.now(), l.hooks),
    result,
  };
}
