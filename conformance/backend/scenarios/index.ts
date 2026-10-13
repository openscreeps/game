import type { Scenario } from '../types.ts';
import gameplay from './gameplay.ts';
import maintenance from './maintenance.ts';
import npc from './npc.ts';
import world from './world.ts';

export const scenarios: Scenario[] = [...world, ...maintenance, ...npc, ...gameplay];

const names = new Set<string>();
for (const scenario of scenarios) {
  if (names.has(scenario.name)) throw new Error(`duplicate scenario ${scenario.name}`);
  names.add(scenario.name);
}
