/*
 * Per-tick records kept in the game state: room history frames, per-minute statistics and the
 * monthly leaderboard.
 */

import type { TickResult, TickRunResult } from '@openscreeps/engine';
import type { GameState, StatisticsSample } from './contracts.ts';

const MINUTE = 60000;
const STATISTICS_RETENTION = 7 * 24 * 60 * MINUTE;

/** Leaderboard season (`YYYY-MM`, UTC) containing `timestamp`. */
export function seasonOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

/**
 * Appends the tick's history frames, then drops frames older than `retainTicks` plus one chunk
 * (`chunkSize`) behind `gameTime`, so complete chunks remain readable.
 */
export function recordHistory(
  state: GameState,
  simulation: TickResult,
  retainTicks: number,
  chunkSize: number,
): void {
  for (const [room, objects] of Object.entries(simulation.history)) {
    (state.history[room] ??= []).push({ time: simulation.gameTime, objects });
  }
  const cutoff = simulation.gameTime - retainTicks - chunkSize;
  for (const [room, frames] of Object.entries(state.history)) {
    let expired = 0;
    while (expired < frames.length && (frames[expired]?.time ?? Infinity) < cutoff) expired++;
    if (expired) frames.splice(0, expired);
    if (!frames.length) Reflect.deleteProperty(state.history, room);
  }
}

/** Accumulates room counters and player CPU/memory into the sample of the tick's minute. */
export function recordStatistics(
  state: GameState,
  simulation: TickResult,
  runtime: TickRunResult,
  timestamp: number,
): void {
  const time = Math.floor(timestamp / MINUTE) * MINUTE;
  let sample = state.statistics.at(-1);
  if (!sample || sample.time !== time) {
    sample = { time, tick: simulation.gameTime, ticks: 0, rooms: {}, users: {} };
    state.statistics.push(sample);
  }
  sample.tick = simulation.gameTime;
  sample.ticks++;
  for (const [room, users] of Object.entries(simulation.roomStats)) {
    const targetRoom = (sample.rooms[room] ??= {});
    for (const [userId, counters] of Object.entries(users)) {
      const targetUser = (targetRoom[userId] ??= {});
      for (const [counter, value] of Object.entries(counters)) {
        targetUser[counter] = (targetUser[counter] ?? 0) + value;
      }
    }
  }
  for (const [userId, result] of Object.entries(runtime.users)) {
    const previous = sample.users[userId];
    const user = state.world.users[userId];
    const entry: StatisticsSample['users'][string] = {
      cpu: ((previous?.cpu ?? 0) * (sample.ticks - 1) + result.cpu.used) / sample.ticks,
      memory: result.memorySize,
      bucket: Number.isFinite(result.cpu.bucket) ? result.cpu.bucket : 0,
      gcl: user?.gcl ?? 0,
      power: user?.power ?? 0,
    };
    sample.users[userId] = entry;
  }
  const cutoff = time - STATISTICS_RETENTION;
  let expired = 0;
  while ((state.statistics[expired]?.time ?? Infinity) < cutoff) expired++;
  if (expired) state.statistics.splice(0, expired);
}

/**
 * Adds one tick's room statistics to the scores of the season containing `timestamp`: `world`
 * scores the control points a player upgraded (`energyControl`, equal to the GCL gained), `power`
 * the power processed. Amounts of ids that are not registered users are ignored.
 */
export function recordLeaderboard(
  state: GameState,
  roomStats: TickResult['roomStats'],
  timestamp: number,
): void {
  const season = seasonOf(timestamp);
  for (const byUser of Object.values(roomStats)) {
    for (const [userId, stats] of Object.entries(byUser)) {
      const world = stats['energyControl'] ?? 0;
      const power = stats['powerProcessed'] ?? 0;
      if ((world <= 0 && power <= 0) || !Object.hasOwn(state.world.users, userId)) {
        continue;
      }
      // Seasons (`YYYY-MM`) and user ids (hex) never name inherited properties.
      const scores = (state.leaderboard[season] ??= {});
      const previous = scores[userId] ?? { world: 0, power: 0 };
      scores[userId] = { world: previous.world + world, power: previous.power + power };
    }
  }
}
