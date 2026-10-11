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

Node 24.21.0 is pinned in `mise.toml`. Installation builds the commit-pinned engine
Git dependency and this package; no sibling engine checkout is required.
`isolated-vm` requires a supported native binary or build toolchain.
`npm run check` runs strict TypeScript, ESLint, formatting, behavioral tests and
declaration compilation on the package.

To verify an unpublished change in a sibling engine checkout without changing
the portable Git dependency pin:

```sh
npm --prefix ../engine run build
npm install --no-save --package-lock=false --ignore-scripts ../engine
npm run check
```

This links the locally built engine for development only. A clean installation
still uses the pinned Git revision; publishing the engine change and updating
the dependency pin and lockfile are required before distributing it with the game.
The engine's `examples/simulation-benchmark.ts` measures production-sized
simulation workloads independently of player scripts and persistence.

The package is currently distributed from Git, not the npm registry. Consumers
should pin a full commit of `github:openscreeps/game` and approve its build script
under their npm install-script policy. The `prepare` script builds distributable
JavaScript and declarations when installed from Git.
The engine pin is `d9c5a8f50d654273fa5e5645f05afca65e6c3274`, including
accuracy-checked reductions in world scanning and runtime-index allocations.
Maintenance, tick processing and storage ordering remain enabled and unchanged.


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
and simulation results plus maintenance failures and notification batches. Hosts
that run maintenance on their own wall clock, as the upstream backend's one-second
cron timer does, pass `maintenance: false` and call `runJob`/`pruneJobs` between
ticks; `simulation` passes processor hooks for server mods. `constants` gives
the world its mod-changed constants (a `createConstants()` copy, as also
accepted by `createGameState`); the session's simulation, player runtime and
all exported operations on its world use them.

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

Room-object processing follows the pinned storage write order; rooms use its
LIFO queue. Domain and world operations record their own writes. If an embedder
directly changes a room object, call `recordRoomObjectWrite(world, id)` afterwards;
for bulk writes use `recordRoomObjectWrites(world, ids)` with IDs in actual write
order. Both are exported by this package. Removals need no call; otherwise
unrecorded inserts are discovered at the next tick or recorded write.
Snapshots preserve `roomObjectWriteSeq` and `writeSeq`; do not discard or edit
these fields. See [engine#4](https://github.com/openscreeps/engine/issues/4).

Room history is disabled by default; set `historyTicks` and `historyChunkSize` to
retain it. Supply `now` for a controlled maintenance clock. CPU measurements still
depend on hardware, and player use of time/randomness affects replay equivalence.
Notification recipient preferences are supplied through optional maintenance
hooks; delivery and account credentials remain host responsibilities. Each
notification batch carries formatted `messages` and the source `notifications`
(`message`, `date`, `count`, `type`) that upstream hands to mailer mods.

## Source and compatibility

World and gameplay behavior derives from the public standalone implementation
pinned in `reference-versions.json`; simulation uses the engine revision pinned
in the package manifest. This is not a claim of equivalence to private MMO
infrastructure. Upstream attribution is retained in `LICENSE` and
`THIRD_PARTY_NOTICES.md`.

## Differential conformance

```sh
npm run conformance:setup
npm run conformance
```

Setup clones the pinned backend, common and storage implementations into
`.reference/` and installs their locked JavaScript dependencies with lifecycle
scripts disabled. Both setup and execution reject changed upstream tracked files
or incorrect checkout revisions. The runner executes original backend modules
with original LokiJS storage, fixed clocks and controlled random inputs; it does
not substitute reimplemented game rules for the reference.

For a focused reproduction and machine-readable report:

```sh
node conformance/backend.mjs --list
node conformance/backend.mjs --scenario world.generate.options --out .reference/report.json
```

Reports distinguish matching steps, unexpected differences, execution errors and
explicit expected divergences. They include reference revisions, source state,
normalization and unsupported areas. New generated IDs are compared through a
document correspondence; pre-existing IDs and semantic fields remain checked.
Unexpected differences or scenario errors fail the command. CI runs the suite on
Windows and Ubuntu.

The policy is **preserve safety and completed functionality, match gameplay**:
ordinary upstream gameplay quirks are preserved, but credential/security and
unrelated-player protections remain. Working features are not removed to emulate
upstream TODOs, crashes or no-ops. Each expected divergence asserts exact outcomes
on both sides and is reported separately, never counted as a matching step.
See [CONFORMANCE.md](CONFORMANCE.md) for the complete divergence register, coverage
boundaries, reproduced defects and linked GitHub tickets.

This is scenario-based evidence against public standalone sources, not proof of
complete Screeps parity. It does not verify live Steam authentication, an
interactive official-client session, private MMO services or all gameplay
combinations. Runtime and multi-tick processor comparisons live in the engine
repository. Reproduced defects are tracked in the game and engine GitHub issues.
