/*
 * Helpers for gameplay scenarios that call original backend routes (express handlers invoked
 * directly) and the matching `game/src` operations.
 */
import type { Projection, Side, Step } from '../types.ts';
import type { RouterName } from '../upstream.ts';

export interface RouteOptions {
  user?: string | undefined;
  body?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  local: Step['local'];
  result?: Projection | undefined;
  op?: string | undefined;
  expected?: Step['expected'];
  before?: Step['before'];
}

/** Upstream route response (`{ok: 1, ...}` / `{error}`) and local outcome -> comparable value. */
export function apiResult(
  project: (value: unknown, side: Side) => unknown = () => undefined,
): Projection {
  return (outcome, side) => {
    if (side === 'upstream') {
      if (!outcome.ok) return { error: `harness: ${outcome.error}` };
      const value = outcome.value ?? {};
      // Route responses are JSON objects; primitive responses retain the original rest semantics.
      const { error, ...data } = Object(value) as Record<string, unknown>;
      Reflect.deleteProperty(data, 'ok');
      if (error !== undefined) return { error };
      return { ok: project(data, side) ?? null };
    }
    if (!outcome.ok) return { error: outcome.error };
    return { ok: project(outcome.value, side) ?? null };
  };
}

/** A step calling `router` `method path` upstream and `local(l, game)` locally. */
export function route(
  router: RouterName,
  method: string,
  path: string,
  { user, body, query, local, result, op, expected, before }: RouteOptions,
): Step {
  return {
    op:
      op ??
      `${method.toUpperCase()} ${path} ${JSON.stringify(body ?? query ?? {})} as ${String(user)}`,
    before,
    expected,
    upstream: (o) => o.api(router, method, path, { userId: user, body, query }),
    local,
    result: result ?? apiResult(),
  };
}
