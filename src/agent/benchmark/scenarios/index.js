/**
 * scenarios/index.js — registry of all benchmark scenarios
 */

import { createWheatFarmScenario } from './wheat_farm.js';
import { createIronMineScenario } from './iron_mine.js';
import { createShelterBuildScenario } from './shelter_build.js';
import { createTreeFarmScenario } from './tree_farm.js';
import { createVillageOutpostScenario } from './village_outpost.js';
import { createNetherExpeditionScenario } from './nether_expedition.js';

export const SCENARIO_FACTORIES = {
    wheat_farm_benchmark: createWheatFarmScenario,
    iron_mine_benchmark: createIronMineScenario,
    shelter_build_benchmark: createShelterBuildScenario,
    tree_farm_benchmark: createTreeFarmScenario,
    village_outpost_benchmark: createVillageOutpostScenario,
    nether_expedition_benchmark: createNetherExpeditionScenario,
};

export const ALL_SCENARIOS = Object.keys(SCENARIO_FACTORIES);

export function createScenario(name) {
    const factory = SCENARIO_FACTORIES[name];
    if (!factory) throw new Error(`Unknown scenario: ${name}. Available: ${ALL_SCENARIOS.join(', ')}`);
    return factory();
}

export function createAllScenarios() {
    return ALL_SCENARIOS.map(name => createScenario(name));
}

export {
    createWheatFarmScenario,
    createIronMineScenario,
    createShelterBuildScenario,
    createTreeFarmScenario,
    createVillageOutpostScenario,
    createNetherExpeditionScenario,
};
