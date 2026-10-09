# OpenScreeps game

A headless Screeps-compatible game world built on
[OpenScreeps engine](https://github.com/openscreeps/engine). Generate worlds, manage
players and NPCs, submit gameplay actions, explicitly advance ticks and restore
snapshots without an HTTP server or database.

## Package boundaries

- `@openscreeps/engine`: player JavaScript runtime, Game APIs, pathfinding, intent
  resolution and simulation rules.
- `@openscreeps/game`: world generation, players and code branches, NPCs,
  maintenance, gameplay operations, tick orchestration and game snapshots.
- `@openscreeps/server`: authentication, HTTP/SockJS, ORM persistence, durable
  commits, wall-clock scheduling and administration.

This package has no NestJS, Express or TypeORM dependency. It opens no database
and starts no tick timer. The official client remains unchanged.

## Development

```sh
mise install
mise run install
npm run check
```

Node 24.21.0 is pinned in `mise.toml`. Installation builds the pinned engine Git
dependency and this package. `isolated-vm` requires a supported native binary or
build toolchain. `npm run check` runs strict TypeScript, ESLint, formatting,
behavioral tests and declaration compilation on the package.

The package is currently distributed from Git, not the npm registry. Consumers
should pin a full commit of `github:openscreeps/game` and approve its build script
under their npm install-script policy. The `prepare` script builds distributable
JavaScript and declarations when installed from Git.

## Run a world

After building, use `./dist/index.js` locally; installed consumers import
`@openscreeps/game`.

```ts
import { GameSession, createGameState } from './dist/index.js';

const game = new GameSession({
  state: createGameState({ size: 3, seed: 1 }),
});
try {
  const bot = game.spawnBot(
    'example',
    { main: 'module.exports.loop = () => { Memory.ticks = (Memory.ticks || 0) + 1; };' },
    'W1N1',
  );
  await game.tick();
  console.log(game.runtime.getMemory(bot.userId));

  const snapshot = game.snapshot();
  await game.tick();
  game.restore(snapshot);
  await game.tick();
} finally {
  game.dispose();
}
```

`GameSession` owns the live player runtime and simulation. `tick()` runs due
maintenance, refreshes changed terrain, executes player scripts, resolves queued
intents, advances simulation and records statistics. Its result includes runtime
and simulation results plus maintenance failures and notification batches.

Use `createPlayer`, `saveCode`, `removePlayer` and `spawnBot` on the session for
player lifecycle operations. Exported functions such as `placeSpawn`,
`createConstructionSite`, `createFlag`, `addObjectIntent` and `addGlobalIntent`
accept game context/state, a user ID and plain domain inputs—not HTTP requests.
Domain failures throw `GameError`; hosts decide how to present them.

## State, concurrency and snapshots

The constructor adopts `state` without copying it. Session methods reject calls
while a tick is running or after disposal. Hosts must serialize exported free
functions, direct state writes and direct runtime calls around `tick()` too.
After editing terrain or room accessibility, call `terrainChanged()` before the
next tick. No transactional rollback is implicit in this in-memory API.

`snapshot()` returns an isolated copy of game fields with the live runtime data.
It excludes extra host records such as profiles, passwords, tokens and scheduler
configuration. Game snapshots still contain private player code, memory and
segments; protect them accordingly. `parseGameState(value)` validates untrusted
snapshots before adoption. `restore(snapshot)` copies game fields and restarts
player isolates, preserving extra host records. JavaScript heaps are not
serialized: restore causes a global reset, while code and memory survive.

`adopt(state, { runtime: 'preserve', terrainDirty })` supports host rollback to an
already validated committed state. It keeps player heaps only if the restored
runtime snapshot equals the live runtime data. Server persistence remains
responsible for atomic commits and external publication after commit.

Room history is disabled by default; set `historyTicks` and `historyChunkSize` to
retain it. Supply `now` for a controlled maintenance clock. CPU measurements still
depend on hardware, and player use of time/randomness affects replay equivalence.
Notification recipient preferences are supplied through optional maintenance
hooks; delivery and account credentials remain host responsibilities.

## Source and compatibility

World and gameplay behavior derives from the public standalone implementation
pinned in `reference-versions.json`; simulation uses the engine revision pinned
in the package manifest. This is not a claim of equivalence to private MMO
infrastructure. Upstream attribution is retained in `LICENSE` and
`THIRD_PARTY_NOTICES.md`.
