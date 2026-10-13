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

import type { WorldRandom as Random } from '../../src/world/random.ts';
import { createWorldState } from '@openscreeps/engine';

export interface Controls {
  RealDate: DateConstructor;
  seed(state: number): void;
  readonly rngState: number;
  readonly draws: number;
  setNow(ms: number): void;
  readonly now: number;
  inStorage<T, A extends unknown[]>(
    fn: (this: T, ...args: A) => unknown,
    self: T,
    args: A,
  ): unknown;
}

const RealDate = globalThis.Date;

export function installControls(WorldRandom: typeof Random): Controls {
  const backend = createWorldState({ rngState: 0 });
  const storage = createWorldState({ rngState: 0x5eed5eed });
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
    constructor(
      ...args:
        | []
        | [string | number | Date]
        | [number, number, number?, number?, number?, number?, number?]
    ) {
      if (args.length === 0) super(clock);
      else if (args.length === 1) super(args[0]);
      else super(...args);
    }
    static override now() {
      return clock;
    }
  }
  globalThis.Date = ControlledDate as DateConstructor;

  return {
    RealDate,
    /** Seed the backend stream (the local side seeds `world.rngState` with the same value). */
    seed(state: number) {
      backend.rngState = state >>> 0;
      draws = 0;
    },
    get rngState() {
      return backend.rngState;
    },
    get draws() {
      return draws;
    },
    setNow(ms: number) {
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
