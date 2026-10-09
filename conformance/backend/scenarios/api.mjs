/*
 * Helpers for gameplay scenarios that call original backend routes (express handlers invoked
 * directly) and the matching `game/src` operations.
 */

/** Upstream route response (`{ok: 1, ...}` / `{error}`) and local outcome -> comparable value. */
export function apiResult(project = () => undefined) {
  return (outcome, side) => {
    if (side === 'upstream') {
      if (!outcome.ok) return { error: `harness: ${outcome.error}` };
      const { ok, error, ...data } = outcome.value ?? {};
      if (error !== undefined) return { error };
      return { ok: project(data, side) ?? null };
    }
    if (!outcome.ok) return { error: outcome.error };
    return { ok: project(outcome.value, side) ?? null };
  };
}

/** A step calling `router` `method path` upstream and `local(l, game)` locally. */
export function route(
  router,
  method,
  path,
  { user, body, query, local, result, op, expected, before },
) {
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
