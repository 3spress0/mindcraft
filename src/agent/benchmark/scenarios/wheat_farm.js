/**
 * wheat_farm.js — first benchmark scenario: deterministic autonomy benchmark
 *
 * Flow:
 * Start project
 * → discover shortage
 * → gather materials
 * → interruption
 * → restart
 * → resume correct phase/subtask
 * → construction completes
 * → damage existing structure
 * → observation detects mismatch
 * → recovery selects repair/replan
 * → construction resumes
 * → verification succeeds
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

// Simple 5x5 wheat farm construction blueprint
function makeWheatFarmConstruction() {
    // 5x5 area, y=0 is farmland, y=1 is crops/fence, etc.
    // We'll create a minimal representation:
    // Layer 0: farmland 5x5, with water in center
    // Layer 1: wheat on farmland, fence around
    const size = 5;
    const blocks = [];

    // Layer 0: farmland
    const layer0 = [];
    for (let z = 0; z < size; z++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            if (x === 2 && z === 2) row.push('water');
            else row.push('farmland');
        }
        layer0.push(row);
    }
    blocks.push(layer0);

    // Layer 1: wheat + fence border (fence at y=0 actually, but for demo put at y=1)
    const layer1 = [];
    for (let z = 0; z < size; z++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            if (x === 2 && z === 2) row.push('air'); // water below
            else if (x === 0 || x === size - 1 || z === 0 || z === size - 1) row.push('oak_fence');
            else row.push('wheat');
        }
        layer1.push(row);
    }
    blocks.push(layer1);

    return {
        name: 'wheat_farm',
        offset: 0,
        blocks,
    };
}

export function createWheatFarmScenario() {
    const construction = makeWheatFarmConstruction();
    const basePos = { x: 100, y: 64, z: 100 };

    return new Scenario({
        name: 'wheat_farm_benchmark',
        description: 'Deterministic autonomy benchmark: build a small wheat farm with shortage, interruption, restart, damage, and repair.',
        initial_world: {
            inventory: {
                // Intentionally missing wheat_seeds to trigger shortage
                dirt: 10,
                oak_log: 5,
            },
            position: { x: 95, y: 64, z: 95 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'wheat_seeds', pos: { x: 110, y: 64, z: 95 }, confidence: 0.7, detail: { depleted: true } },
                    { name: 'wheat_seeds', pos: { x: 150, y: 64, z: 110 }, confidence: 0.8, detail: { depleted: false } },
                    { name: 'oak_log', pos: { x: 90, y: 64, z: 90 }, confidence: 0.7 },
                ],
                locations: [
                    { name: 'home_base', kind: 'base', pos: { x: 90, y: 64, z: 90 } },
                    { name: 'shelter', kind: 'shelter', pos: { x: 85, y: 64, z: 85 } },
                ],
                threats: [],
                structures: [],
            },
            blocks: {
                // Some existing terrain
                '100,63,100': 'dirt',
                '101,63,100': 'dirt',
                '100,63,101': 'dirt',
            },
        },
        project: {
            goal: 'Build a small 5x5 wheat farm with water source and fence',
            summary: 'Gather seeds, craft hoe, till soil, plant, water, fence, verify',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Preparation' },
                { title: 'Construction' },
                { title: 'Verification' },
            ],
            steps: [
                {
                    title: 'Gather wheat seeds',
                    instruction: 'Gather at least 10 wheat seeds from tall grass or village farm',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'wheat_seeds', gained: 10 },
                },
                {
                    title: 'Gather dirt',
                    instruction: 'Gather 20 dirt blocks for farm foundation',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'dirt', gained: 10 },
                },
                {
                    title: 'Craft wooden hoe',
                    instruction: 'Craft a wooden hoe using sticks and planks',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'wooden_hoe', atLeast: 1 },
                    expected_delta: { 'inventory.wooden_hoe': 1, 'inventory.oak_log': -2 },
                },
                {
                    title: 'Till farmland',
                    instruction: 'Till a 5x5 area at (100,64,100) into farmland',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'farmland', radius: 10, atLeast: 20 },
                },
                {
                    title: 'Place water source',
                    instruction: 'Place water in center of farmland at (102,64,102)',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'water', radius: 8, atLeast: 1 },
                },
                {
                    title: 'Plant wheat seeds',
                    instruction: 'Plant wheat seeds on farmland',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'wheat', radius: 10, atLeast: 8 },
                },
                {
                    title: 'Build fence',
                    instruction: 'Build oak fence around the farm perimeter',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'oak_fence', radius: 12, atLeast: 8 },
                },
                {
                    title: 'Verify wheat farm',
                    instruction: 'Verify 5x5 wheat farm with water and fence is complete',
                    phase: 3,
                    expected: { kind: 'construction', snapshotId: 'wheat_farm@100,64,100#0', name: 'wheat_farm', tolerance: 0.15 },
                },
            ],
        },
        injected_events: [
            {
                id: 'shortage_seeds',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.MISSING_RESOURCES,
                data: { missing: ['wheat_seeds'], message: "don't have enough wheat_seeds" },
                description: 'Start project → discover shortage',
            },
            {
                id: 'depleted_deposit',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'wheat_seeds',
                    depletedPos: { x: 110, y: 64, z: 95 },
                    alternativePos: { x: 150, y: 64, z: 110 },
                },
                description: 'Nearest seed source depleted, alternative known 40m away',
            },
            {
                id: 'interruption_gather',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 1 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'simulated user interruption during gathering' },
                description: 'Interruption after gathering dirt',
            },
            {
                id: 'restart_resume',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 2 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'restart after interruption' },
                description: 'Restart → resume correct phase/subtask',
            },
            {
                id: 'damage_farm',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Plant wheat seeds' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: {
                    snapshotId: 'wheat_farm@100,64,100#0',
                    count: 6,
                    blocks: [
                        { x: 100, y: 64, z: 100 },
                        { x: 101, y: 64, z: 100 },
                        { x: 102, y: 64, z: 100 },
                    ],
                },
                description: 'Damage existing structure after construction',
            },
            {
                id: 'threat_during_verify',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 7 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: { threat: 'zombie', pos: { x: 105, y: 64, z: 105 }, health: 8 },
                description: 'Threat/low health during verification',
            },
        ],
        expected_recoveries: [
            {
                eventId: 'shortage_seeds',
                expectedAction: 'navigate',
                expectedReason: 'target_depleted',
                description: 'Should gather missing seeds via navigate/search to alternative deposit',
            },
            {
                eventId: 'depleted_deposit',
                expectedAction: 'navigate',
                expectedReason: 'target_depleted',
                description: 'Should navigate to alternative deposit',
            },
            {
                eventId: 'interruption_gather',
                expectedAction: 'resume',
                description: 'Should resume after interruption',
            },
            {
                eventId: 'damage_farm',
                expectedAction: 'replan',
                expectedReason: 'construction_damaged',
                description: 'Observation detects mismatch → recovery selects repair/replan',
            },
        ],
        success_condition: {
            kind: 'all_steps_done',
        },
    });
}

export const wheatFarmScenario = createWheatFarmScenario();
export default wheatFarmScenario;
