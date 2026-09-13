/**
 * village_outpost.js — establish village outpost with trading, permissions, threats
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeOutpostConstruction() {
    // 6x6 outpost: walls, chest, crafting table, bed, fence
    const blocks = [];
    // y=0: foundation
    blocks.push([
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'cobblestone'],
        ['cobblestone', 'oak_planks', 'air', 'air', 'oak_planks', 'cobblestone'],
        ['cobblestone', 'oak_planks', 'air', 'air', 'oak_planks', 'cobblestone'],
        ['cobblestone', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
    ]);
    // y=1: walls + chest + crafting
    blocks.push([
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'chest', 'crafting_table', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'bed', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
    ]);
    // y=2: roof
    blocks.push([
        ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
        ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
        ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
        ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
        ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
        ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
    ]);

    return {
        name: 'village_outpost',
        offset: 0,
        blocks,
    };
}

export function createVillageOutpostScenario() {
    const construction = makeOutpostConstruction();
    const basePos = { x: 500, y: 64, z: 500 };

    return new Scenario({
        name: 'village_outpost_benchmark',
        description: 'Establish village outpost with trading, permission negotiation, and raid defense.',
        initial_world: {
            inventory: {
                cobblestone: 20,
                oak_log: 10,
                emerald: 1,
            },
            position: { x: 490, y: 64, z: 490 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'emerald', pos: { x: 510, y: 64, z: 510 }, confidence: 0.5 },
                    { name: 'oak_log', pos: { x: 480, y: 64, z: 480 }, confidence: 0.8 },
                ],
                locations: [
                    { name: 'village', kind: 'village', pos: { x: 500, y: 64, z: 520 } },
                    { name: 'trading_hall', kind: 'structure', pos: { x: 505, y: 64, z: 515 } },
                ],
                threats: [],
            },
            blocks: {},
        },
        project: {
            goal: 'Build village outpost with storage, crafting, and bed near village',
            summary: 'Gather materials, trade, build outpost, secure',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Scouting' },
                { title: 'Construction' },
                { title: 'Securing' },
            ],
            steps: [
                {
                    title: 'Scout village',
                    instruction: 'Navigate to village at (500,64,520) and locate trading hall',
                    phase: 1,
                    expected: { kind: 'near', x: 500, y: 64, z: 520, radius: 15 },
                },
                {
                    title: 'Trade for materials',
                    instruction: 'Trade with villagers for oak planks and bed',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'oak_planks', gained: 10 },
                },
                {
                    title: 'Gather cobblestone',
                    instruction: 'Gather 30 cobblestone for outpost walls',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'cobblestone', gained: 20 },
                },
                {
                    title: 'Build outpost foundation',
                    instruction: 'Build foundation at (500,64,500)',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 12, atLeast: 15 },
                },
                {
                    title: 'Build outpost walls',
                    instruction: 'Build walls and place chest, crafting table',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'oak_planks', radius: 12, atLeast: 8 },
                },
                {
                    title: 'Secure outpost',
                    instruction: 'Place bed and secure perimeter',
                    phase: 3,
                    expected: { kind: 'block_near', block: 'bed', radius: 10, atLeast: 1 },
                },
                {
                    title: 'Verify outpost',
                    instruction: 'Verify outpost complete and safe',
                    phase: 3,
                    expected: { kind: 'construction', snapshotId: 'village_outpost@500,64,500#0', tolerance: 0.2 },
                },
            ],
        },
        injected_events: [
            {
                id: 'emerald_shortage',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 1 },
                type: EVENT_TYPES.MISSING_RESOURCES,
                data: { missing: ['emerald'], message: "don't have enough emeralds to trade" },
            },
            {
                id: 'village_permission',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 3 },
                type: EVENT_TYPES.UNAVAILABLE_PERMISSIONS,
                data: { message: 'village golem protects area - cannot build without permission' },
            },
            {
                id: 'raid_threat',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 4 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: { threat: 'pillager', pos: { x: 505, y: 64, z: 505 }, health: 8 },
            },
            {
                id: 'interruption_trade',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 1 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'villager restock interruption' },
            },
            {
                id: 'restart_after_raid',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 5 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'resume after raid defense' },
            },
            {
                id: 'pillager_damage',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Build outpost walls' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'village_outpost@500,64,500#0', count: 6 },
            },
        ],
        expected_recoveries: [
            { eventId: 'emerald_shortage', expectedAction: 'gather', expectedReason: 'materials_missing', description: 'Should gather emeralds via alternative' },
            { eventId: 'village_permission', expectedAction: 'human', expectedReason: 'permission_required', description: 'Permission wall should trigger human pause or event' },
            { eventId: 'raid_threat', expectedAction: 'retreat', expectedReason: 'danger_nearby', description: 'Should retreat from pillager' },
            { eventId: 'interruption_trade', expectedAction: 'resume', description: 'Should resume after villager restock' },
            { eventId: 'pillager_damage', expectedAction: 'replan', expectedReason: 'construction_damaged' },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const villageOutpostScenario = createVillageOutpostScenario();
export default villageOutpostScenario;
