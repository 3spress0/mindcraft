/**
 * shelter_build.js — build emergency shelter with permissions, damage, interruption
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeShelterConstruction() {
    // 5x4x3 shelter: walls cobblestone, roof, door
    const blocks = [];
    // y=0: floor and walls base
    blocks.push([
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
    ]);
    // y=1: walls
    blocks.push([
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'air', 'air', 'cobblestone'],
        ['cobblestone', 'air', 'cobblestone', 'cobblestone', 'cobblestone'],
    ]);
    // y=2: roof
    blocks.push([
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
        ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
    ]);

    return {
        name: 'emergency_shelter',
        offset: 0,
        blocks,
    };
}

export function createShelterBuildScenario() {
    const construction = makeShelterConstruction();
    const basePos = { x: -100, y: 64, z: -100 };

    return new Scenario({
        name: 'shelter_build_benchmark',
        description: 'Build emergency shelter with permission failure, creeper damage, and restart recovery.',
        initial_world: {
            inventory: {
                dirt: 30,
                oak_log: 10,
            },
            position: { x: -105, y: 64, z: -105 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'cobblestone', pos: { x: -90, y: 64, z: -90 }, confidence: 0.8 },
                    { name: 'oak_log', pos: { x: -110, y: 64, z: -110 }, confidence: 0.7 },
                ],
                threats: [],
                locations: [
                    { name: 'spawn', kind: 'spawn', pos: { x: -100, y: 64, z: -100 } },
                ],
            },
            blocks: {
                '-100,63,-100': 'grass_block',
            },
        },
        project: {
            goal: 'Build emergency shelter at (-100,64,-100) with walls, roof, and door',
            summary: 'Gather cobblestone, craft tools, build shelter, survive night',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Gathering' },
                { title: 'Construction' },
                { title: 'Fortification' },
            ],
            steps: [
                {
                    title: 'Gather cobblestone',
                    instruction: 'Gather 40 cobblestone for shelter',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'cobblestone', gained: 20 },
                },
                {
                    title: 'Craft wooden door',
                    instruction: 'Craft wooden door and planks',
                    phase: 1,
                    expected: { kind: 'inventory', item: 'oak_door', atLeast: 1 },
                },
                {
                    title: 'Build shelter walls',
                    instruction: 'Build cobblestone walls at (-100,64,-100) 5x4 area',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 10, atLeast: 15 },
                },
                {
                    title: 'Build roof',
                    instruction: 'Build roof over shelter',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 10, atLeast: 10 },
                },
                {
                    title: 'Place door',
                    instruction: 'Place door at shelter entrance',
                    phase: 2,
                    expected: { kind: 'block_near', block: 'oak_door', radius: 8, atLeast: 1 },
                },
                {
                    title: 'Verify shelter',
                    instruction: 'Verify shelter is intact and safe',
                    phase: 3,
                    expected: { kind: 'construction', snapshotId: 'emergency_shelter@-100,64,-100#0', tolerance: 0.15 },
                },
            ],
        },
        injected_events: [
            {
                id: 'perm_claim',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 2 },
                type: EVENT_TYPES.UNAVAILABLE_PERMISSIONS,
                data: { message: 'cannot build here - land claimed' },
            },
            {
                id: 'creeper_damage',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Build shelter walls' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'emergency_shelter@-100,64,-100#0', count: 8 },
            },
            {
                id: 'night_threat',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 3 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: { threat: 'zombie', pos: { x: -95, y: 64, z: -100 }, health: 12 },
            },
            {
                id: 'interruption_night',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 3 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'nightfall interruption - need to hide' },
            },
            {
                id: 'restart_morning',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 4 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'morning resume' },
            },
        ],
        expected_recoveries: [
            { eventId: 'perm_claim', expectedAction: 'human', expectedReason: 'permission_required', description: 'Permission wall should pause for human or trigger replan via damage' },
            { eventId: 'creeper_damage', expectedAction: 'replan', expectedReason: 'construction_damaged' },
            { eventId: 'night_threat', expectedAction: 'retreat', expectedReason: 'danger_nearby', description: 'Should retreat from zombie threat' },
            { eventId: 'interruption_night', expectedAction: 'resume' },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const shelterBuildScenario = createShelterBuildScenario();
export default shelterBuildScenario;
