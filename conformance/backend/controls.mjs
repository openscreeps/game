/*
 * Controlled nondeterminism for the backend oracle. Upstream backend code calls the global
 * `Math.random()`/`Date`; the local port draws from `WorldRandom` (mulberry32 over
 * `world.rngState`) and receives `now` explicitly. Installing these controls before any upstream
 * module loads (lodash 3 captures `Math.random` at load) makes both implementations consume the
 * same uniform stream and read the same clock.
 *
 * The storage process is separate upstream, so its document id generator gets its own stream:
 * id values are normalized by the comparison and must not shift the backend's draws.
 */

const RealDate = globalThis.Date;

export function installControls(WorldRandom) {
  const backend = { rngState: 0 };
  const storage = { rngState: 0x5eed5eed };
  const backendRandom = new WorldRandom(backend);
  const storageRandom = new WorldRandom(storage);
  let inStorage = 0;
  let draws = 0;
  let clock = RealDate.UTC(2026, 0, 15, 12, 0, 0);

  Math.random = function random() {
    if (inStorage) return storageRandom.next();
    draws++;
    return backendRandom.next();
  };

  class ControlledDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock);
      else super(...args);
    }
    static now() {
      return clock;
    }
  }
  globalThis.Date = ControlledDate;

  return {
    RealDate,
    /** Seed the backend stream (the local side seeds `world.rngState` with the same value). */
    seed(state) {
      backend.rngState = state >>> 0;
      draws = 0;
    },
    get rngState() {
      return backend.rngState;
    },
    get draws() {
      return draws;
    },
    setNow(ms) {
      clock = ms;
    },
    get now() {
      return clock;
    },
    /** Run storage-process code with the storage stream. */
    inStorage(fn, self, args) {
      inStorage++;
      try {
        return fn.apply(self, args);
      } finally {
        inStorage--;
      }
    },
  };
}
