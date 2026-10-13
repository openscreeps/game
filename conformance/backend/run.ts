/*
 * Scenario runner: every step runs the same operation against the original backend (over the
 * original storage) and against `game/src`, from identical state, seed and clock, then compares
 * results and the full resulting state.
 */

import { canonical, compareStates, createLabeler, fromUpstream, knownIds } from './compare.ts';
import { fromLocal, toLocal } from './local.ts';
import type { CodeModules } from '../../src/index.ts';
import type { Controls, Difference, Dump, Game, Oracle, Outcome, Scenario } from './types.ts';

interface ExpectedReport {
  id: string;
  kind: string;
  reason: string;
  upstreamAssertion: boolean;
  localAssertion: boolean;
  result: { upstream: unknown; local: unknown } | undefined;
  diffs: Difference[];
}
export interface StepReport {
  step: number;
  op: string;
  status: 'match' | 'expected-divergence' | 'mismatch' | 'carried-mismatch';
  results: { upstream: unknown; local: unknown };
  diffs: Difference[];
  carriedDiffs: Difference[];
  expectedDivergences: ExpectedReport[];
  hostOwnedFields: Difference[];
  rng: { seed: number; upstreamDraws: number; aligned: boolean };
  notes: string[];
}
export interface ScenarioReport {
  scenario: string;
  covers?: string[] | undefined;
  status: 'match' | 'expected-divergence' | 'mismatch' | 'error';
  steps?: StepReport[];
  error?: string;
}

const STEP_TIMEOUT_MS = 60_000;

function hashSeed(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function settleUpstream(oracle: Oracle, run: () => unknown): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('upstream step timed out'));
        }, STEP_TIMEOUT_MS);
      }),
    ]);
    await oracle.settle();
    return { ok: true, value };
  } catch (error) {
    await oracle.settle();
    return { ok: false, error: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

function runLocal(run: () => unknown): Outcome {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Default result projection: success vs. error message. */
function defaultProjection(outcome: Outcome) {
  return outcome.ok ? { ok: true } : { error: outcome.error };
}

export async function runScenario(
  scenario: Scenario,
  {
    oracle,
    controls,
    game,
    base,
  }: {
    oracle: Oracle;
    controls: Controls;
    game: Game;
    base: Dump;
  },
): Promise<ScenarioReport> {
  const dump = structuredClone(base);
  const helpers = { C: oracle.C };
  scenario.setup?.(dump, helpers);
  controls.setNow(scenario.now ?? Date.UTC(2026, 0, 15, 12, 0, 0));
  await oracle.load(dump);
  const initial = oracle.dump();
  const translate = (modules: CodeModules) =>
    oracle.modules.utils.translateModulesFromDb(structuredClone(modules));
  const initialView = fromUpstream(initial, initial, translate);
  const labeler = createLabeler(knownIds(initial));
  const local = toLocal(game, initial, () => controls.now, translate);
  const steps: StepReport[] = [];
  let failed = false;
  let previous = new Set<string>();
  const identity = (diff: Difference) =>
    JSON.stringify([diff.collection, diff.key, diff.path, diff.upstream, diff.local]);

  for (const [index, step] of scenario.steps.entries()) {
    if (step.now !== undefined) controls.setNow(step.now);
    if (step.before) {
      await step.before({ oracle, local, controls });
      await oracle.settle();
    }
    const seed = hashSeed(`${scenario.name}#${String(index)}`);
    controls.seed(seed);
    local.state.world.rngState = seed;
    const upstream = await settleUpstream(oracle, () => step.upstream(oracle, helpers));
    const upstreamRng = controls.rngState;
    const upstreamDraws = controls.draws;
    const localOutcome = runLocal(() => step.local(local, game, helpers));
    const localRng = local.state.world.rngState;

    const project = step.result ?? defaultProjection;
    const results = {
      upstream: canonical(project(upstream, 'upstream')),
      local: canonical(project(localOutcome, 'local')),
    };
    const resultMatch = JSON.stringify(results.upstream) === JSON.stringify(results.local);
    const upView = fromUpstream(oracle.dump(), initial, translate);
    const loView = fromLocal(local);
    const { diffs, hostFields, ambiguous } = compareStates(upView, loView, labeler, initialView);

    /*
     * Named safety divergences: each covers only the diffs its `covers` predicate selects (and the
     * result mismatch when `coversResult`), and both sides must satisfy its explicit assertions
     * on the actual outputs; otherwise the step is a mismatch.
     */
    const expected: ExpectedReport[] = [];
    let remaining = diffs;
    let resultCovered = false;
    for (const divergence of step.expected ?? []) {
      const covers = divergence.covers ?? (() => false);
      const covered = remaining.filter((diff) => covers(diff));
      remaining = remaining.filter((diff) => !covers(diff));
      const upstreamHolds = divergence.assertUpstream(upView, results.upstream);
      const localHolds = divergence.assertLocal(loView, results.local);
      if (divergence.coversResult && !resultMatch) resultCovered = true;
      expected.push({
        id: divergence.id,
        kind: divergence.kind,
        reason: divergence.reason,
        upstreamAssertion: upstreamHolds,
        localAssertion: localHolds,
        result: divergence.coversResult && !resultMatch ? results : undefined,
        diffs: covered,
      });
    }
    const assertionsHold = expected.every((e) => e.upstreamAssertion && e.localAssertion);
    // differences already present before this step (state carried from an earlier mismatch)
    const carried = remaining.filter((diff) => previous.has(identity(diff)));
    const introduced = remaining.filter((diff) => !previous.has(identity(diff)));
    previous = new Set(diffs.map(identity));
    const status =
      (!resultMatch && !resultCovered) || introduced.length || !assertionsHold
        ? 'mismatch'
        : carried.length
          ? 'carried-mismatch'
          : expected.length
            ? 'expected-divergence'
            : 'match';
    if (status === 'mismatch' || status === 'carried-mismatch') failed = true;
    steps.push({
      step: index + 1,
      op: step.op,
      status,
      results,
      diffs: introduced,
      carriedDiffs: carried,
      expectedDivergences: expected,
      hostOwnedFields: hostFields,
      rng: {
        seed,
        upstreamDraws,
        aligned: upstreamRng === localRng,
      },
      notes: ambiguous,
    });
  }
  const statuses = steps.map((s) => s.status);
  return {
    scenario: scenario.name,
    covers: scenario.covers,
    status: failed
      ? 'mismatch'
      : statuses.includes('expected-divergence')
        ? 'expected-divergence'
        : 'match',
    steps,
  };
}
