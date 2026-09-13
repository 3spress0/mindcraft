/**
 * tree_farm.js — sustainable tree farm with resource management and threats
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeTreeFarmConstruction() {
    // 7x7 tree farm: tilled soil, saplings, fence, water, compost
    const size = 7;
    const blocks = [];

    // Layer 0: dirt + farmland + water channels
    const layer0 = [];
    for (let z = 0; z < size; z++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            if ((x === 3 || z === 3) && !(x === 3 && z === 3)) row.push('water');
            else if (x === 0 || x === size - 1 || z === 0 || z === size - 1) row.push('oak_fence');
            else row.push('dirt');
        }
        layer0.push(row);
    }
    blocks.push(layer0);

    // Layer 1: saplings
    const layer1 = [];
    for (let z = 0; z < size; z++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            if (x > 0 && x < size - 1 && z > 0 && z < size - 1 && x !== 3 && z !== 3) {
                if ((x + z) % 2 === 0) row.push('oak_sapling');
                else row.push('air');
            } else {
                row.push('air');
            }
        }
        layer1.push(row);
    }
    blocks.push(layer1);

    return {
        name: 'tree_farm',
        offset: 0,
        blocks,
    };
}

export function createTreeFarmScenario() {
    const construction = makeTreeFarmConstruction();
    const basePos = { x: 300, y: 64, z: 300 };

    return new Scenario({
        name: 'tree_farm_benchmark',
        description: 'Build sustainable tree farm with sapling shortage, tool wear, and growth management.',
        initial_world: {
            inventory: {
                dirt: 20,
                oak_log: 5,
                bone_meal: 3,
            },
            position: { x: 295, y: 64, z: 295 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'oak_sapling', pos: { x: 310, y: 64, z: 310 }, confidence: 0.6, detail: { depleted: true } },
                    { name: 'oak_sapling', pos: { x: 350, y: 64, z: 320 }, confidence: 0.8 },
                    { name: 'oak_log', pos: { x: 290, y: 64, z: 290 }, confidence: 0.9 },
                ],
                threats: [],
                locations: [
                    { name: 'forest', kind: 'forest', pos: { x: 350, y: 64, z: 320 } },
                ],
            },
            blocks: {},
        },
        project: {
            goal: 'Build sustainable 7x7 tree farm with irrigation and fence',
            summary: 'Gather saplings, prepare soil, plant, water, protect',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Preparation' },
                { title: 'Planting' },
                { title: 'Growth' },
            ],
            steps: [
                {
                    title: 'Gather saplings',
                    instruction: 'Gather 8 oak saplings',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'oak_sapling', gained: 8 },
                },
                {
                    title: 'Gather dirt',
                    instruction: 'Gather 20 dirt for farm beds',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'dirt', gained: 15 },
                },
                {
                    title: 'Till soil',
                    instruction: 'Prepare 7x7 dirt area at (300,64,300)',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'dirt', radius: 10, atLeast: 20 },
                },
                {
                    title: 'Place water channels',
                    instruction: 'Place water channels for irrigation',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'water', radius: 10, atLeast: 3 },
                },
                {
                    title: 'Plant saplings',
                    instruction: 'Plant saplings in farm beds',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'oak_sapling', radius: 10, atLeast: 4 },
                },
                {
                    title: 'Build fence',
                    instruction: 'Build fence around tree farm',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'oak_fence', radius: 12, atLeast: 8 },
                },
                {
                    title: 'Verify tree farm',
                    instruction: 'Verify tree farm is complete with water and saplings',
                    phase: 3,
                    expected: { kind: 'construction', snapshotId: 'tree_farm@300,64,300#0', tolerance: 0.2 },
                },
            ],
        },
        injected_events: [
            {
                id: 'sapling_shortage',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.MISSING_RESOURCES,
                data: { missing: ['oak_sapling'], message: "don't have enough saplings" },
            },
            {
                id: 'depleted_sapling',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'oak_sapling',
                    depletedPos: { x: 310, y: 64, z: 310 },
                    alternativePos: { x: 350, y: 64, z: 320 },
                },
            },
            {
                id: 'interruption_growth',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 2 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'sapling growth interruption - need bone meal' },
            },
            {
                id: 'restart_growth',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 3 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'resume after gathering bone meal' },
            },
            {
                id: 'trample_damage',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Plant saplings' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'tree_farm@300,64,300#0', count: 5 },
            },
            {
                id: 'skeleton_threat',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 5 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: { threat: 'skeleton', pos: { x: 305, y: 64, z: 305 }, health: 14 },
            },
        ],
        expected_recoveries: [
            { eventId: 'sapling_shortage', expectedAction: 'navigate', expectedReason: 'target_depleted' },
            { eventId: 'depleted_sapling', expectedAction: 'navigate', expectedReason: 'target_depleted' },
            { eventId: 'interruption_growth', expectedAction: 'resume' },
            { eventId: 'trample_damage', expectedAction: 'replan', expectedReason: 'construction_damaged' },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const treeFarmScenario = createTreeFarmScenario();
export default treeFarmScenario;
