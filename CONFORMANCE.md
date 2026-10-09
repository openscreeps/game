# Differential conformance and retained divergences

Run `npm run conformance:setup`, then `npm run conformance`. Original backend,
common and LokiJS storage revisions are pinned in `reference-versions.json`.
Reports contain reference revisions, the local source state, exercised operations,
random-draw alignment, field-level differences and exclusions.

## Policy

Preserve safety and existing completed functionality; match ordinary gameplay
quirks. Upstream incomplete features or runtime failures do not justify removing
working local features. Every retained difference must be documented here and in
a GitHub ticket, asserted narrowly on both sides by its scenario, and reported
separately from matching steps. Unexpected mismatches and oracle errors fail the
runner. A passing run is not a claim of full standalone or private-MMO parity.

## Coverage and results

`node conformance/backend.mjs` runs 66 scenarios (499 steps). They cover world
generation and room operations, all 11 cron jobs, bots/respawn/strongholds, and
the original `game.js`, `power-creeps.js`, `market.js` and `user.js` routes
that have a game equivalent. Current tree: 477 steps match, 22 steps are named
expected divergences in 11 scenarios, and there are 0 mismatches and 0 errors
(`.reference/backend-current-verified.json`). Expected divergences are never
counted as matches. Random draws differ between the two sides only in the
`stronghold-explicit-position` and `bot-username-case-insensitive` steps;
the run reports this as information only. A passing run does not mean the
random sequence matches everywhere.

## Reproduced port defects

The baseline is local game revision `7b645845951f2d30d7324a23b13bb69713875af0`
(`.reference/game-7b64584`, run with `--local-root`). Over the first 63
scenarios it produced 43 mismatching scenarios, with 136 mismatching and 142
carried-mismatch steps (`.reference/backend-baseline-verified.json`). The
scenarios added later were checked individually on the baseline:
`maintenance.genPowerBanks.occupied-spots` and `npc.bots.username-case` mismatch,
and `npc.strongholds.explicit-position` gives the same expected divergence as
today. A carried mismatch repeats a difference caused by an earlier step, so
these counts are not counts of independent bugs. The defects below have
checked-in fixes; their issues record the verified publication revision and
resolution status. Retained divergences remain open separately.

| Defect                                                                                                                             | Reproduction (`--scenario`)                                                                                                             | Tracking                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Source regeneration field: the original stores `ticksToRegeneration: 300`; local omitted it.                                       | `world.generate.adjacent.W11N3`                                                                                                         | [game#1](https://github.com/openscreeps/game/issues/1)   |
| Keeper lairs: an extra mineral lair changed the random draws (W11N5 density 3/70000 vs the original's 2/35000).                    | `world.generate.options`                                                                                                                | [game#2](https://github.com/openscreeps/game/issues/2)   |
| Room lifecycle: room activation, open/close of a missing room, removeRoom contents.                                                | `world.room-ops`                                                                                                                        | [game#3](https://github.com/openscreeps/game/issues/3)   |
| Cron jobs: NPC order terminal order, orphan notifications, genDeposits quirks, power-bank spots.                                   | `maintenance.recreateNpcOrders`, `maintenance.sendNotifications`, `maintenance.genDeposits`, `maintenance.genPowerBanks.occupied-spots` | [game#4](https://github.com/openscreeps/game/issues/4)   |
| Bots: bots.spawn draw order and documents, removeUser scope, respawnUser ruins and activation.                                     | `npc.bots.lifecycle`, `npc.bots.names`, `npc.respawn`                                                                                   | [game#5](https://github.com/openscreeps/game/issues/5)   |
| Flags: missing-room error, validation, empty-document upsert, limit, duplicate documents.                                          | `gameplay.flags.*`                                                                                                                      | [game#6](https://github.com/openscreeps/game/issues/6)   |
| Construction blocking rules, extractor spot, optional spawn name, controllers without a level.                                     | `gameplay.construction.rcl8`, `gameplay.spawn.place`, `gameplay.spawn.place-levelless-controller`                                       | [game#7](https://github.com/openscreeps/game/issues/7)   |
| Manual/global intents: `$merge`, sanitizer, room intents, safe-mode checks, global whitelist.                                      | `gameplay.intents.object`, `gameplay.intents.safe-mode`, `gameplay.intents.global`                                                      | [game#8](https://github.com/openscreeps/game/issues/8)   |
| Invaders: name random draws, room activation, extra checks; notify-when-attacked object types.                                     | `gameplay.invaders.lifecycle`, `gameplay.objects.notify-when-attacked`                                                                  | [game#9](https://github.com/openscreeps/game/issues/9)   |
| Power creeps: name coercion and upgrade check order.                                                                               | `gameplay.power-creeps.lifecycle`, `gameplay.power-creeps.fractional-level`                                                             | [game#10](https://github.com/openscreeps/game/issues/10) |
| Views: map-stats fields, unknown room overview, market queries without a resourceType, branch active flags, `active` on code save. | `gameplay.map.*`, `gameplay.market.views`, `gameplay.user.*`                                                                            | [game#11](https://github.com/openscreeps/game/issues/11) |

The createPlayer default-branch timestamp
([game#15](https://github.com/openscreeps/game/issues/15)) is outside the
66-scenario suite and its totals. It was reproduced by a separate throwaway
probe, whose runnable JS is in the issue. The probe loads the original
`auth.js` with a host storage boundary, calls the real `steamFindOrCreateUser`,
and compares the result with `GameSession.createPlayer` from the baseline and
the current tree. The original and the current tree store
`{branch:'default',modules:{main:''},activeWorld:true,activeSim:true}`; the
baseline also stored `timestamp`. The probe did not authenticate with Steam.

Fixes that only source review supports have no reproduction and are not
claimed as reproduced: the hang guards in generateRoom, spawnBot and
genPowerBanks, and local errors where the original throws a TypeError or
ReferenceError.

## Retained divergences

Each divergence is asserted on both sides only for the listed fields and steps.

| id                                   | Kind           | Original → local                                                                                                                  | Steps                                      | Tracking                                                 |
| ------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `GP-D1 manual-intent-ownership`      | safety         | Original queues manual intents for any object id → local queues them only for objects the player owns or controls.                | `gameplay.intents.ownership` 1-4           | [game#12](https://github.com/openscreeps/game/issues/12) |
| `GP-D2 manual-intent-shape`          | safety         | Original stores intent shapes that crash the processor, or that target another room → local answers `invalid params`.             | `gameplay.intents.malformed` 1-4           | [game#12](https://github.com/openscreeps/game/issues/12) |
| `GP-D3 invader-coordinates`          | safety         | Original stores x/y unparsed → local stores integers (only `.x`/`.y` are excluded from comparison).                               | `gameplay.invaders.coordinates` 1          | [game#12](https://github.com/openscreeps/game/issues/12) |
| `GP-D4 power-level-integer`          | safety         | Original stores a fractional power level → local rejects it.                                                                      | `gameplay.power-creeps.fractional-level` 3 | [game#12](https://github.com/openscreeps/game/issues/12) |
| `GP-D8 market-order-owner-privacy`   | safety         | Original exposes other players' user ids on orders → local hides them.                                                            | `gameplay.market.views` 2, 3, 5            | [game#12](https://github.com/openscreeps/game/issues/12) |
| `GP-D5 power-experimentation-delete` | upstream-crash | Original throws a TypeError (`db.remove`) and keeps the creep → local deletes it.                                                 | `gameplay.power-creeps.lifecycle` 43       | [game#13](https://github.com/openscreeps/game/issues/13) |
| `GP-D6 map-stats-rankings`           | upstream-todo  | Original returns empty stats → local returns rankings from recorded statistics.                                                   | `gameplay.map.stats` 2                     | [game#13](https://github.com/openscreeps/game/issues/13) |
| `GP-D7 room-overview-stats`          | upstream-todo  | Original returns empty stats/totals → local returns recorded ones (same owner on both sides).                                     | `gameplay.map.room-overview` 1-3           | [game#13](https://github.com/openscreeps/game/issues/13) |
| `stronghold-explicit-position`       | upstream-noop  | Original returns without placing (templateName+x+y) → local places bunker1 at W6N6 25,25. The baseline behaves the same as local. | `npc.strongholds.explicit-position` 1      | [game#13](https://github.com/openscreeps/game/issues/13) |
| `respawn-unrelated-room-status`      | safety         | Original respawnUser reopens every room → local resets only the player's own rooms (only `.status` excluded).                     | `npc.respawn` 1-2                          | [game#14](https://github.com/openscreeps/game/issues/14) |
| `bot-username-case-insensitive`      | safety         | Original creates `testbot` next to `TestBot` → local rejects it.                                                                  | `npc.bots.username-case` 2                 | [game#14](https://github.com/openscreeps/game/issues/14) |

Pass the reproduction options to `node conformance/backend.mjs`. Issues record
fix and publication status; original before-output was captured before source
edits. Storage-generated identifiers are mapped between equivalent new documents,
Loki bookkeeping is removed, and active rooms use set semantics. Semantic world
fields, existing IDs and gameplay failures are not blanket-filtered.

## Limits

This suite does not authenticate against live Steam, operate an interactive
Screeps client, or compare private MMO services. Engine runtime and processor
comparisons are in the engine repository, with their own explicit boundaries.
Not compared: HTTP/express, rate limits, auth/accounts/Steam/tokens/e-mail
delivery, socket/pubsub fan-out, CLI sandbox and system controls, map PNG assets
and the terrain cache, badge SVG, leaderboard, user messages/console/memory,
respawn routes, live-MMO features (shards, portals, subscriptions, CPU unlock,
pixels, seasons), and the scheduling of `cronjobs.run()`. Routes with no game
equivalent (world-start-room, badge, time/tick, POST rooms) and inputs that
only crash the original are also out of scope (see `report.unsupported`).
