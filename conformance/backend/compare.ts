/*
 * Comparison of the original backend storage and the local game after the same operations.
 *
 * Normalization is limited to:
 * - LokiJS bookkeeping (`meta`, `$loki`) and storage-generated ids: ids present in the shared
 *   starting state are kept verbatim; ids created during the scenario are relabeled on both sides
 *   in the canonical order of the documents they identify (references are relabeled with them);
 * - `rooms.terrain`, `rooms.intents` and `users.intents` document ids (nothing references them);
 * - set semantics of `env.activeRooms` (`sadd`/`smembers`);
 * - named host-owned values: `env.terrainData` (host terrain cache rebuilt by the server) and the
 *   account fields of `users` documents reported separately by `HOST_USER_FIELDS`.
 * Every other difference, including changes to collections or env keys the local game has no
 * representation for, is reported.
 */

import { HOST_USER_FIELDS } from './local.ts';
import { isRecord } from '../../src/guards.ts';
import type { CodeModules } from '../../src/index.ts';
import type { Document, Dump, Difference, Side, TranslateModules, View } from './types.ts';
import { isDeepStrictEqual } from 'node:util';

export interface Labeler {
  relabel(up: View, lo: View): { up: View; lo: View; ambiguous: string[] };
}
interface ValueDifference {
  path: string;
  upstream: unknown;
  local: unknown;
}
interface KeyEntry {
  id: string;
  key: string;
}

// host terrain cache (map.updateTerrainData) and the driver-written accessible rooms list
const HOST_ENV_KEYS = new Set(['terrainData', 'accessibleRooms']);
const RUNTIME_ENV_PREFIX = 'memory:';
const MAP_VIEW_PREFIX = 'mapView:';

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(canonical);
  if (isRecord(value)) {
    const result: Document = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

const json = (value: unknown) => JSON.stringify(canonical(value));

/**
 * Upstream storage dump -> comparison layout (same shape as `fromLocal`). `translateModules` is the
 * original `utils.translateModulesFromDb` (stored module names escape `.`, `/` and `\`).
 */
export function fromUpstream(
  dump: Dump,
  initial: Dump,
  translateModules: TranslateModules = (modules) => modules,
): View {
  const collections: Record<string, Document[]> = {};
  for (const [name, docs] of Object.entries(dump.collections)) {
    collections[name] = docs.map((doc) => structuredClone(doc));
  }
  for (const doc of collections['users.code'] ?? []) {
    if (doc.modules) doc.modules = translateModules(doc.modules as CodeModules);
    // upstream stores `new Date()` (ISO string after the RPC) or `getTime()` depending on the route
    if (typeof doc.timestamp === 'string') doc.timestamp = Date.parse(doc.timestamp);
  }
  collections['rooms.terrain'] = (collections['rooms.terrain'] ?? []).map(({ room, terrain }) => ({
    room,
    terrain,
  }));
  const intents = new Map<unknown, { room: unknown; users: Document }>();
  for (const doc of collections['rooms.intents'] ?? []) {
    const merged = intents.get(doc.room) ?? { room: doc.room, users: {} };
    Object.assign(merged.users, doc.users ?? {});
    intents.set(doc.room, merged);
  }
  collections['rooms.intents'] = [...intents.values()];
  const globals = new Map<unknown, { user: unknown; intents: Record<string, unknown[]> }>();
  for (const doc of collections['users.intents'] ?? []) {
    const merged: { user: unknown; intents: Record<string, unknown[]> } = globals.get(doc.user) ?? {
      user: doc.user,
      intents: {},
    };
    for (const [name, list] of Object.entries((doc.intents ?? {}) as Record<string, unknown[]>)) {
      (merged.intents[name] ??= []).push(...list);
    }
    globals.set(doc.user, merged);
  }
  collections['users.intents'] = [...globals.values()];

  const envData = dump.env[0]?.data ?? {};
  const initialEnv = initial.env[0]?.data ?? {};
  const memory: Record<string, unknown> = {};
  const mapViews: Record<string, unknown> = {};
  const unmappedEnv: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(envData), ...Object.keys(initialEnv)])) {
    if (key.startsWith(RUNTIME_ENV_PREFIX)) {
      // an empty memory string and an absent key both mean "no Memory stored"
      if (envData[key] !== undefined && envData[key] !== '') {
        memory[key.slice(RUNTIME_ENV_PREFIX.length)] = envData[key];
      }
    } else if (key.startsWith(MAP_VIEW_PREFIX)) {
      if (envData[key] !== undefined) {
        const value = envData[key];
        mapViews[key.slice(MAP_VIEW_PREFIX.length)] =
          typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      }
    } else if (!['gameTime', 'activeRooms'].includes(key) && !HOST_ENV_KEYS.has(key)) {
      if (json(envData[key]) !== json(initialEnv[key])) unmappedEnv[key] = envData[key] ?? null;
    }
  }
  return {
    collections,
    env: {
      gameTime: Number.parseInt(String(envData.gameTime), 10),
      activeRooms: [...(envData.activeRooms ?? [])],
      memory,
      mapViews,
    },
    unmappedEnv,
  };
}

const KEY_FIELD: Record<string, string> = {
  'rooms.terrain': 'room',
  'rooms.intents': 'room',
  'users.intents': 'user',
};
const NO_ID = new Set(['rooms', 'rooms.terrain', 'rooms.intents', 'users.intents']);

export function knownIds(dump: Dump) {
  const ids = new Set<string>();
  for (const docs of Object.values(dump.collections)) {
    for (const doc of docs) if (typeof doc._id === 'string') ids.add(doc._id);
  }
  return ids;
}

function replaceIds(value: unknown, labels: Map<string, string>): unknown {
  if (typeof value === 'string') return labels.get(value) ?? value;
  if (Array.isArray(value)) return (value as unknown[]).map((item) => replaceIds(item, labels));
  if (isRecord(value)) {
    const result: Document = {};
    for (const [key, item] of Object.entries(value))
      result[labels.get(key) ?? key] = replaceIds(item, labels);
    return result;
  }
  return value;
}

const byKey = (a: KeyEntry, b: KeyEntry) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Labels for ids created during one scenario, kept for the whole scenario so references to
 * documents removed later (e.g. a ruin's `structure.id`) stay comparable. New documents are paired
 * across sides first by identical content (other new ids masked or already labeled), then in
 * canonical content order; each pair shares one label.
 */
export function createLabeler(known: Set<string>): Labeler {
  const labels = { upstream: new Map<string, string>(), local: new Map<string, string>() };
  const counters = new Map<string, number>();
  const ambiguous: string[] = [];

  function fresh(view: View, side: Side) {
    const result = new Map<string, string>();
    for (const [name, docs] of Object.entries(view.collections)) {
      if (NO_ID.has(name)) continue;
      for (const doc of docs) {
        if (typeof doc._id === 'string' && !known.has(doc._id) && !labels[side].has(doc._id)) {
          result.set(doc._id, name);
        }
      }
    }
    return result;
  }

  function assign(upView: View, loView: View) {
    const pending = { upstream: fresh(upView, 'upstream'), local: fresh(loView, 'local') };
    const masks = {} as Record<Side, Map<string, string>>;
    for (const side of ['upstream', 'local'] as const) {
      masks[side] = new Map([
        ...labels[side],
        ...[...pending[side].keys()].map((id): [string, string] => [id, '#new']),
      ]);
    }
    const entries = (view: View, side: Side, name: string): KeyEntry[] =>
      (view.collections[name] ?? [])
        .filter(
          (doc): doc is Document & { _id: string } =>
            typeof doc._id === 'string' && pending[side].has(doc._id),
        )
        .map((doc) => ({
          id: doc._id,
          key: json(replaceIds({ ...doc, _id: undefined }, masks[side])),
        }))
        .sort(byKey);
    const names = new Set([...pending.upstream.values(), ...pending.local.values()]);
    for (const name of [...names].sort()) {
      const next = () => {
        const n = (counters.get(name) ?? 0) + 1;
        counters.set(name, n);
        return `<new ${name} #${String(n)}>`;
      };
      let up = entries(upView, 'upstream', name);
      const lo = entries(loView, 'local', name);
      // identical documents first
      const unmatched: KeyEntry[] = [];
      for (const entry of up) {
        const index = lo.findIndex((other) => other.key === entry.key);
        const other = lo[index];
        if (!other) {
          unmatched.push(entry);
          continue;
        }
        const label = next();
        labels.upstream.set(entry.id, label);
        labels.local.set(other.id, label);
        lo.splice(index, 1);
      }
      up = unmatched;
      // then differing documents in canonical order
      for (let i = 0; i < Math.max(up.length, lo.length); i++) {
        const label = next();
        const upEntry = up[i];
        const loEntry = lo[i];
        if (upEntry) labels.upstream.set(upEntry.id, label);
        if (loEntry) labels.local.set(loEntry.id, label);
        if (upEntry && i > 0 && up[i - 1]?.key === upEntry.key)
          ambiguous.push(`${name}: identical new documents`);
      }
    }
  }

  function apply(view: View, side: Side): View {
    const map = labels[side];
    const collections: Record<string, Document[]> = {};
    for (const [name, docs] of Object.entries(view.collections)) {
      collections[name] = docs.map((doc) => replaceIds(doc, map) as Document);
    }
    return {
      ...view,
      collections,
      env: {
        ...view.env,
        memory: replaceIds(view.env.memory, map) as Record<string, unknown>,
        activeRooms: [...new Set(view.env.activeRooms)].sort(),
      },
    };
  }

  return {
    relabel(upView, loView) {
      assign(upView, loView);
      return {
        up: apply(upView, 'upstream'),
        lo: apply(loView, 'local'),
        ambiguous: ambiguous.splice(0),
      };
    },
  };
}

function diffValues(
  path: string,
  a: unknown,
  b: unknown,
  out: ValueDifference[],
  limit: number,
): void {
  if (out.length >= limit) return;
  // Most steps leave most documents untouched: avoid sorting/stringifying equal JSON trees.
  if (isDeepStrictEqual(a, b) || json(a) === json(b)) return;
  const objects =
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b);
  if (objects && isRecord(a) && isRecord(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      diffValues(`${path}.${key}`, a[key], b[key], out, limit);
    }
    return;
  }
  if (objects && Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    (a as unknown[]).forEach((item, index) => {
      diffValues(`${path}[${String(index)}]`, item, b[index], out, limit);
    });
    return;
  }
  out.push({
    path,
    upstream: a === undefined ? '<absent>' : a,
    local: b === undefined ? '<absent>' : b,
  });
}

function keyOf(name: string, doc: Document) {
  return String(doc[KEY_FIELD[name] ?? '_id']);
}

function splitHost(doc: Document | undefined): [Document | undefined, Document] {
  if (!doc) return [doc, {}];
  const game = { ...doc };
  const host: Document = {};
  for (const field of HOST_USER_FIELDS) {
    if (field in game) host[field] = game[field];
    Reflect.deleteProperty(game, field);
  }
  return [game, host];
}

/**
 * Compare both sides; returns `{diffs, hostFields, ambiguous}`. `diffs` entries are
 * `{collection, key, path, upstream, local}`. `labeler` comes from `createLabeler` (one per
 * scenario). `initialView` is the upstream starting state, used for collections the local game has
 * no representation of (any change there is a difference).
 */
export function compareStates(
  upstreamView: View,
  localView: View,
  labeler: Labeler,
  initialView: View,
  { limit = 200 } = {},
) {
  const relabeled = labeler.relabel(upstreamView, localView);
  const up = { view: relabeled.up };
  const lo = { view: relabeled.lo };
  const diffs: Difference[] = [];
  const hostFields: Difference[] = [];
  const localNames = new Set(Object.keys(lo.view.collections));
  for (const name of Object.keys(upstreamView.collections)
    .filter((n) => !localNames.has(n))
    .sort()) {
    if (json(upstreamView.collections[name]) !== json(initialView.collections[name] ?? [])) {
      diffs.push({
        collection: name,
        key: '',
        path: 'unmapped upstream change',
        upstream: upstreamView.collections[name],
        local: '<no local representation>',
      });
    }
  }
  for (const name of [...localNames].sort()) {
    const left = new Map((up.view.collections[name] ?? []).map((doc) => [keyOf(name, doc), doc]));
    const right = new Map((lo.view.collections[name] ?? []).map((doc) => [keyOf(name, doc), doc]));
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      let a = left.get(key);
      let b = right.get(key);
      if (name === 'users') {
        const [ga, ha] = splitHost(a);
        const [gb, hb] = splitHost(b);
        a = ga;
        b = gb;
        const hostDiff: ValueDifference[] = [];
        diffValues('', ha, hb, hostDiff, limit);
        for (const entry of hostDiff) hostFields.push({ collection: name, key, ...entry });
      }
      const out: ValueDifference[] = [];
      diffValues('', a, b, out, limit - diffs.length);
      for (const entry of out) diffs.push({ collection: name, key, ...entry });
    }
  }
  const envOut: ValueDifference[] = [];
  diffValues('env', up.view.env, lo.view.env, envOut, limit);
  for (const entry of envOut) diffs.push({ collection: 'env', key: '', ...entry });
  for (const [key, value] of Object.entries(upstreamView.unmappedEnv ?? {})) {
    diffs.push({
      collection: 'env',
      key,
      path: 'unmapped upstream env change',
      upstream: value,
      local: '<no local representation>',
    });
  }
  return { diffs, hostFields, ambiguous: relabeled.ambiguous };
}
