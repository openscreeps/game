import gameplay from './gameplay.mjs';
import maintenance from './maintenance.mjs';
import npc from './npc.mjs';
import world from './world.mjs';

export const scenarios = [...world, ...maintenance, ...npc, ...gameplay];

const names = new Set();
for (const scenario of scenarios) {
  if (names.has(scenario.name)) throw new Error(`duplicate scenario ${scenario.name}`);
  names.add(scenario.name);
}
