/**
 * iron_mine.js — mining iron with depleted veins, tool requirements, threats
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeIronMineConstruction() {
    // Simple mine shaft representation: 3x3 vertical shaft with supports
    const blocks = [];
    const size = 3;
    // Layer 0-2: shaft walls
    for (let y = 0; y < 3; y++) {
        const layer = [];
        for (let z = 0; z < size; z++) {
            const row = [];
            for (let x = 0; x < size; x++) {
                if (x === 1 && z === 1) row.push('air'); // shaft center
                else row.push('cobblestone');
            }
            layer.push(row);
        }
        blocks.push(layer);
    }
    // Layer 3: iron ore deposit
    blocks.push([
        ['iron_ore', 'iron_ore', 'stone'],
        ['iron_ore', 'stone', 'stone'],
        ['stone', 'stone', 'stone'],
    ]);

    return {
        name: 'iron_mine_shaft',
        offset: -2,
        blocks,
    };
}

export function createIronMineScenario() {
    const construction = makeIronMineConstruction();
    const basePos = { x: 200, y: 50, z: 200 };

    return new Scenario({
        name: 'iron_mine_benchmark',
        description: 'Mine iron ore with depleted vein handling, tool shortage, lava threat, and interruption recovery.',
        initial_world: {
            inventory: {
                // Missing pickaxe to trigger shortage
                cobblestone: 20,
                torch: 10,
            },
            position: { x: 195, y: 64, z: 195 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'iron_ore', pos: { x: 200, y: 45, z: 200 }, confidence: 0.6, detail: { depleted: true } },
                    { name: 'iron_ore', pos: { x: 220, y: 40, z: 210 }, confidence: 0.8, detail: { depleted: false } },
                    { name: 'coal', pos: { x: 198, y: 55, z: 198 }, confidence: 0.7 },
                ],
                threats: [],
                locations: [
                    { name: 'mine_entrance', kind: 'mine', pos: { x: 200, y: 64, z: 200 } },
                    { name: 'safe_room', kind: 'shelter', pos: { x: 195, y: 64, z: 195 } },
                ],
            },
            blocks: {
                '200,63,200': 'stone',
                '200,62,200': 'stone',
            },
        },
        project: {
            goal: 'Mine at least 10 iron ore and build a safe mine shaft',
            summary: 'Craft pickaxe, locate vein, mine iron, handle depletion, build supports, smelt',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Preparation' },
                { title: 'Mining' },
                { title: 'Processing' },
            ],
            steps: [
                {
                    title: 'Craft stone pickaxe',
                    instruction: 'Craft stone pickaxe from cobblestone and sticks',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'stone_pickaxe', atLeast: 1 },
                },
                {
                    title: 'Gather coal',
                    instruction: 'Gather 5 coal for torches and smelting',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'coal', gained: 5 },
                },
                {
                    title: 'Locate iron vein',
                    instruction: 'Navigate to iron vein at (200,45,200) and verify iron ore nearby',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'iron_ore', radius: 12, atLeast: 2 },
                },
                {
                    title: 'Mine iron ore',
                    instruction: 'Mine at least 10 iron ore',
                    phase: 2,
                    expected: { kind: 'inventory', item: 'iron_ore', gained: 10 },
                },
                {
                    title: 'Build mine supports',
                    instruction: 'Build cobblestone supports around shaft at (200,50,200)',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 8, atLeast: 6 },
                },
                {
                    title: 'Smelt iron',
                    instruction: 'Smelt iron ore into iron ingots using furnace',
                    phase: 3,
                    expected: { kind: 'inventory', item: 'iron_ingot', gained: 5 },
                },
                {
                    title: 'Verify mine',
                    instruction: 'Verify mine shaft is safe and iron secured',
                    phase: 3,
                    expected: { kind: 'construction', snapshotId: 'iron_mine_shaft@200,50,200#0', tolerance: 0.2 },
                },
            ],
        },
        injected_events: [
            {
                id: 'missing_pickaxe',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.MISSING_RESOURCES,
                data: { missing: ['stone_pickaxe', 'wooden_pickaxe'], message: "don't have pickaxe to mine" },
            },
            {
                id: 'depleted_vein',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 2 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'iron_ore',
                    depletedPos: { x: 200, y: 45, z: 200 },
                    alternativePos: { x: 220, y: 40, z: 210 },
                },
            },
            {
                id: 'lava_threat',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 3 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: { threat: 'lava', pos: { x: 202, y: 44, z: 200 }, health: 10 },
            },
            {
                id: 'interruption_mining',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 3 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'cave-in interruption during mining' },
            },
            {
                id: 'restart_after_cavein',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 4 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'resume after cave-in' },
            },
            {
                id: 'damage_shaft',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Mine iron ore' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'iron_mine_shaft@200,50,200#0', count: 4 },
            },
        ],
        expected_recoveries: [
            { eventId: 'missing_pickaxe', expectedAction: 'craft', expectedReason: 'materials_missing' },
            { eventId: 'depleted_vein', expectedAction: 'navigate', expectedReason: 'target_depleted' },
            { eventId: 'lava_threat', expectedAction: 'retreat', expectedReason: 'danger' },
            { eventId: 'interruption_mining', expectedAction: 'resume' },
            { eventId: 'damage_shaft', expectedAction: 'replan', expectedReason: 'construction_damaged' },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const ironMineScenario = createIronMineScenario();
export default ironMineScenario;
