#!/usr/bin/env node
/*
 * Differential conformance of the local game (`game/src`, loaded directly) against the pinned
 * original Screeps backend (`.reference/backend`) running over the pinned original storage
 * (`.reference/storage`) and common (`.reference/common`).
 *
 * Prerequisites: `npm run conformance:setup` (clones the pinned references and installs their
 * locked JavaScript dependencies with `npm ci --ignore-scripts`). Node >= 24 (type stripping).
 *
 * Usage: node conformance/backend.mjs [--scenario <name-or-prefix>]... [--out <file>] [--list]
 *        [--local-root <dir>]
 * `--local-root` loads `<dir>/src/index.ts` instead of this checkout's `src` (for example an
 * extracted older revision: `git archive <rev> src | tar -x -C .reference/game-<rev>`; module
 * resolution then still finds this checkout's `node_modules`).
 * Prints one JSON report on stdout (upstream log output goes to stderr). Exit code 1 on any
 * mismatch or harness error.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReferences, referenceRoot } from './references.mjs';
import { installControls } from './backend/controls.mjs';
import { HOST_USER_FIELDS, loadLocal } from './backend/local.mjs';
import { createOracle } from './backend/oracle.mjs';
import { runScenario } from './backend/run.mjs';
import { scenarios } from './backend/scenarios/index.mjs';
import { UNSUPPORTED } from './backend/unsupported.mjs';

const REFERENCES = ['backend', 'common', 'storage'];
const gameRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { scenarios: [], out: undefined, list: false, localRoot: gameRoot };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario') options.scenarios.push(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--list') options.list = true;
    else if (arg === '--local-root') options.localRoot = resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = scenarios.filter(
    (s) =>
      !options.scenarios.length ||
      options.scenarios.some((p) => s.name === p || s.name.startsWith(p)),
  );
  if (options.list) {
    process.stdout.write(`${selected.map((s) => s.name).join('\n')}\n`);
    return 0;
  }
  if (!selected.length) throw new Error('no scenario matches the --scenario filter');

  verifyReferences(REFERENCES);
  const references = Object.fromEntries(
    REFERENCES.map((name) => [name, git(resolve(referenceRoot, name), ['rev-parse', 'HEAD'])]),
  );

  // upstream code logs freely; keep stdout for the report
  const log = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
  console.log = log;
  console.info = log;
  console.warn = log;
  console.error = log;

  const { game, WorldRandom } = await loadLocal(options.localRoot);
  const controls = installControls(WorldRandom);
  const oracle = await createOracle({
    roots: Object.fromEntries(REFERENCES.map((name) => [name, resolve(referenceRoot, name)])),
    controls,
    log,
  });
  const base = oracle.initial;

  const results = [];
  for (const scenario of selected) {
    log(`scenario ${scenario.name}`);
    try {
      results.push(await runScenario(scenario, { oracle, controls, game, base }));
    } catch (error) {
      results.push({
        scenario: scenario.name,
        status: 'error',
        error: String(error?.stack ?? error),
      });
    }
  }
  oracle.close();

  const steps = results.flatMap((r) => r.steps ?? []);
  const count = (status) => steps.filter((s) => s.status === status).length;
  const covered = {};
  for (const scenario of selected)
    for (const op of scenario.covers ?? []) covered[op] = (covered[op] ?? 0) + 1;
  const report = {
    tool: 'openscreeps-game backend conformance',
    references,
    local:
      options.localRoot === gameRoot
        ? {
            source: 'game/src (loaded directly)',
            commit: git(gameRoot, ['rev-parse', 'HEAD']),
            sourceChanges: git(gameRoot, ['status', '--porcelain', '--', 'src'])
              ?.split('\n')
              .filter(Boolean),
          }
        : { source: `${options.localRoot}/src (loaded directly, --local-root)` },
    summary: {
      scenarios: results.length,
      scenariosMatching: results.filter((r) => r.status === 'match').length,
      scenariosWithExpectedDivergence: results.filter((r) => r.status === 'expected-divergence')
        .length,
      scenariosMismatching: results.filter((r) => r.status === 'mismatch').length,
      scenarioErrors: results.filter((r) => r.status === 'error').length,
      steps: steps.length,
      stepsMatching: count('match'),
      stepsExpectedDivergence: count('expected-divergence'),
      stepsMismatching: count('mismatch'),
      stepsCarriedMismatch: count('carried-mismatch'),
      rngMisalignedSteps: steps.filter((s) => !s.rng.aligned).map((s) => s.op),
    },
    coverage: {
      upstreamOperations: covered,
      scenarios: selected.map((s) => s.name),
    },
    normalization: {
      ids: 'storage-generated ids of documents created during a scenario are relabeled on both sides by canonical document order; pre-existing ids are compared verbatim',
      loki: 'LokiJS meta/$loki bookkeeping removed',
      activeRooms: 'compared as a set (env sadd/smembers semantics)',
      hostOwnedUserFields: HOST_USER_FIELDS,
      hostOwnedEnv: [
        'terrainData (server terrain cache)',
        'accessibleRooms (driver-written input)',
      ],
      layout:
        'rooms.nextForceUpdateTime/nextNpcMarketOrder and users.lastNotifyDate map to state.jobs; users.money/resources ISO dates map to epoch ms',
    },
    unsupported: UNSUPPORTED,
    results,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, text);
  await new Promise((done) => process.stdout.write(text, done));
  const failed = report.summary.scenariosMismatching + report.summary.scenarioErrors > 0;
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(2);
  },
);
