/**
 * nether_expedition.js — nether portal and fortress expedition with multi-injection stress test
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeNetherBaseConstruction() {
    // 4x4 nether base: obsidian portal frame + cobblestone walls
    const blocks = [];
    // y=0: obsidian frame base + cobblestone floor
    blocks.push([
        ['obsidian', 'obsidian', 'obsidian', 'obsidian'],
        ['obsidian', 'cobblestone', 'cobblestone', 'obsidian'],
        ['obsidian', 'cobblestone', 'cobblestone', 'obsidian'],
        ['obsidian', 'obsidian', 'obsidian', 'obsidian'],
    ]);
    // y=1: portal frame sides
    blocks.push([
        ['obsidian', 'air', 'air', 'obsidian'],
        ['cobblestone', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'cobblestone'],
        ['obsidian', 'air', 'air', 'obsidian'],
    ]);
    // y=2: portal top + roof
    blocks.push([
        ['obsidian', 'obsidian', 'obsidian', 'obsidian'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['obsidian', 'obsidian', 'obsidian', 'obsidian'],
    ]);

    return {
        name: 'nether_base',
        offset: 0,
        blocks,
    };
}

export function createNetherExpeditionScenario() {
    const construction = makeNetherBaseConstruction();
    const basePos = { x: 0, y: 64, z: 0 };

    return new Scenario({
        name: 'nether_expedition_benchmark',
        description: 'Build nether portal, gather blaze rods, survive ghast threats with interruption and damage recovery.',
        initial_world: {
            inventory: {
                cobblestone: 30,
                obsidian: 8,
                flint_and_steel: 1,
            },
            position: { x: -5, y: 64, z: -5 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'obsidian', pos: { x: 20, y: 12, z: 20 }, confidence: 0.8 },
                    { name: 'blaze_rod', pos: { x: 100, y: 70, z: 100 }, confidence: 0.6, detail: { dimension: 'nether' } },
                    { name: 'nether_wart', pos: { x: 110, y: 70, z: 110 }, confidence: 0.5, detail: { depleted: true } },
                    { name: 'nether_wart', pos: { x: 200, y: 70, z: 200 }, confidence: 0.7, detail: { depleted: false } },
                ],
                locations: [
                    { name: 'nether_portal', kind: 'portal', pos: { x: 0, y: 64, z: 0 } },
                    { name: 'fortress', kind: 'fortress', pos: { x: 100, y: 70, z: 100 } },
                    { name: 'safe_bunker', kind: 'shelter', pos: { x: -10, y: 64, z: -10 } },
                ],
                threats: [],
            },
            blocks: {},
        },
        project: {
            goal: 'Build nether portal at (0,64,0), enter nether, gather blaze rods, build safe bunker',
            summary: 'Construct portal, light, enter, gather rods, survive ghast, repair portal',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Preparation' },
                { title: 'Portal Construction' },
                { title: 'Nether Expedition' },
                { title: 'Return & Verify' },
            ],
            steps: [
                {
                    title: 'Gather obsidian',
                    instruction: 'Gather 10 obsidian for portal',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'obsidian', gained: 6 },
                },
                {
                    title: 'Build nether portal',
                    instruction: 'Build obsidian portal frame at (0,64,0)',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'obsidian', radius: 10, atLeast: 8 },
                },
                {
                    title: 'Light portal',
                    instruction: 'Light nether portal with flint and steel',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'nether_portal', radius: 8, atLeast: 1 },
                },
                {
                    title: 'Scout fortress',
                    instruction: 'Navigate to nether fortress at (100,70,100)',
                    phase: 3,
                    expected: { kind: 'near', x: 100, y: 70, z: 100, radius: 15 },
                },
                {
                    title: 'Gather blaze rods',
                    instruction: 'Gather 5 blaze rods from blaze spawners',
                    phase: 3,
                    expected: { kind: 'inventory', item: 'blaze_rod', gained: 5 },
                },
                {
                    title: 'Gather nether wart',
                    instruction: 'Gather nether wart for potions',
                    phase: 3,
                    expected: { kind: 'inventory', item: 'nether_wart', gained: 3 },
                },
                {
                    title: 'Build safe bunker',
                    instruction: 'Build cobblestone bunker near portal for safety',
                    phase: 3,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 12, atLeast: 10 },
                },
                {
                    title: 'Verify nether base',
                    instruction: 'Verify portal and bunker intact',
                    phase: 4,
                    expected: { kind: 'construction', snapshotId: 'nether_base@0,64,0#0', tolerance: 0.2 },
                },
            ],
        },
        injected_events: [
            {
                id: 'obsidian_shortage',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.MISSING_RESOURCES,
                data: { missing: ['obsidian'], message: "don't have enough obsidian for portal" },
            },
            {
                id: 'portal_permission',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 1 },
                type: EVENT_TYPES.UNAVAILABLE_PERMISSIONS,
                data: { message: 'cannot build portal here - spawn protection' },
            },
            {
                id: 'ghast_threat',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 3 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: { threat: 'ghast', pos: { x: 90, y: 70, z: 90 }, health: 6 },
            },
            {
                id: 'depleted_wart',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 5 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'nether_wart',
                    depletedPos: { x: 110, y: 70, z: 110 },
                    alternativePos: { x: 200, y: 70, z: 200 },
                },
            },
            {
                id: 'interruption_nether',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 4 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'ghast fireball interruption' },
            },
            {
                id: 'restart_after_ghast',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 5 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'resume after ghast attack' },
            },
            {
                id: 'portal_damage',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Build safe bunker' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'nether_base@0,64,0#0', count: 5 },
            },
        ],
        expected_recoveries: [
            { eventId: 'obsidian_shortage', expectedAction: 'gather', expectedReason: 'materials_missing', description: 'Should gather obsidian' },
            { eventId: 'portal_permission', expectedAction: 'human', expectedReason: 'permission_required' },
            { eventId: 'ghast_threat', expectedAction: 'retreat', expectedReason: 'danger_nearby', description: 'Should retreat from ghast' },
            { eventId: 'depleted_wart', expectedAction: 'navigate', expectedReason: 'alternate_deposit_known' },
            { eventId: 'interruption_nether', expectedAction: 'resume' },
            { eventId: 'portal_damage', expectedAction: 'replan', expectedReason: 'construction_damaged' },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const netherExpeditionScenario = createNetherExpeditionScenario();
export default netherExpeditionScenario;
