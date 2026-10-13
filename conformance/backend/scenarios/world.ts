/*
 * Room generation and room operations: backend `lib/cli/map.js` generateRoom/openRoom/
 * closeRoom/removeRoom against `game/src/world/generate.ts`.
 */

import type { GenerateRoomOptions } from '../../../src/index.ts';
import type { Scenario, Step } from '../types.ts';

const FUTURE = Date.UTC(2026, 6, 1);

function generate(roomName: string, options: GenerateRoomOptions = {}): Step {
  return {
    op: `map.generateRoom(${JSON.stringify(roomName)}, ${JSON.stringify(options)})`,
    upstream: (o) => o.modules.map.generateRoom(roomName, structuredClone(options)),
    local: (l, game) => {
      game.generateRoom(l.state.world, roomName, structuredClone(options));
    },
  };
}

function open(roomName: string, timestamp?: number): Step {
  return {
    op: `map.openRoom(${JSON.stringify(roomName)}${timestamp ? `, ${String(timestamp)}` : ''})`,
    upstream: (o) => o.modules.map.openRoom(roomName, timestamp),
    local: (l, game) => {
      game.openRoom(l.state.world, roomName, timestamp);
    },
  };
}

function close(roomName: string): Step {
  return {
    op: `map.closeRoom(${JSON.stringify(roomName)})`,
    upstream: (o) => o.modules.map.closeRoom(roomName),
    local: (l, game) => {
      game.closeRoom(l.state.world, roomName);
    },
  };
}

function remove(roomName: string, { withAssets = false }: { withAssets?: boolean } = {}): Step {
  return {
    op: `map.removeRoom(${JSON.stringify(roomName)})`,
    // a real server ships the map image of every existing room; removeRoom unlinks it
    before: withAssets
      ? ({ oracle }) => oracle.modules.map.updateRoomImageAssets(roomName)
      : undefined,
    upstream: (o) => o.modules.map.removeRoom(roomName),
    local: (l, game) => {
      game.removeRoom(l.state, roomName);
    },
  };
}

const lifecycle = (roomName: string): Step[] => [
  generate(roomName),
  open(roomName, FUTURE),
  close(roomName),
  open(roomName),
  remove(roomName),
];

const ADJACENT = ['W11N3', 'W11N7', 'W4N11', 'W8N11', 'E0N4', 'W3S0', 'W11N10', 'E0N0'];

const scenarios: Scenario[] = [
  ...ADJACENT.map((roomName) => ({
    name: `world.generate.adjacent.${roomName}`,
    covers: ['map.generateRoom', 'map.openRoom', 'map.closeRoom', 'map.removeRoom'],
    steps: lifecycle(roomName),
  })),
  ...['E20S20', 'W40N40', 'E7S13'].map((roomName) => ({
    name: `world.generate.isolated.${roomName}`,
    covers: ['map.generateRoom', 'map.openRoom', 'map.closeRoom', 'map.removeRoom'],
    steps: lifecycle(roomName),
  })),
  {
    name: 'world.generate.options',
    covers: ['map.generateRoom'],
    steps: [
      generate('W11N5', { sources: 3, controller: false, keeperLairs: true, mineral: 'X' }),
      generate('W11N4', { sources: 0, controller: false, mineral: false }),
      generate('E30S30', {
        exits: { top: [10, 11, 12], bottom: [], right: [20, 21, 22, 23] },
        terrainType: 14,
        swampType: 6,
        sources: 2,
        mineral: 'H',
      }),
      generate('E31S30', { terrainType: 28, swampType: 0, sources: 1, controller: true }),
      generate('E32S30', { keeperLairs: true, sources: 2, terrainType: 9, swampType: 13 }),
      generate('E30S31', {
        exits: { top: [], left: [5, 6, 7, 30, 31] },
        terrainType: 1,
        swampType: 14,
      }),
    ],
  },
  {
    name: 'world.generate.chain',
    covers: ['map.generateRoom'],
    steps: [
      generate('E40S40'),
      generate('E41S40'),
      generate('E41S41'),
      generate('E40S41'),
      generate('E42S40'),
    ],
  },
  {
    name: 'world.generate.errors',
    covers: ['map.generateRoom'],
    steps: [
      generate('X1Y1'),
      generate('W5N5'),
      generate('W11N3', { exits: { right: [1, 2, 3] } }),
      generate('W11N3', { exits: { top: [] } }),
    ],
  },
  {
    name: 'world.room-ops',
    setup(dump) {
      // a pending manual intent and a flag in the room removed below
      (dump.collections['rooms.intents'] ??= []).push({
        _id: 'fixtureintent1',
        room: 'W9N9',
        users: {
          a1123272b261687: { objectsManual: { e84207717df82e1: { activateSafeMode: {} } } },
        },
      });
      (dump.collections['rooms.flags'] ??= []).push({
        _id: 'fixtureflag1',
        room: 'W9N9',
        user: 'a1123272b261687',
        data: 'F1~1~1~5~5',
      });
    },
    covers: ['map.openRoom', 'map.closeRoom', 'map.removeRoom'],
    steps: [
      open('W0N0', FUTURE),
      close('W1N1'),
      close('W1N1'),
      open('W1N1'),
      open('E50N50'),
      close('E50N50'),
      remove('W9N9', { withAssets: true }),
      remove('W9N9'),
      remove('E50N50'),
    ],
  },
];

export default scenarios;
