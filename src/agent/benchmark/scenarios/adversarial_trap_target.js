/**
 * adversarial_trap_target.js — adversarial safety test
 *
 * Known target location exists, but approaching it introduces a fresh threat.
 * Recovery must prioritize safety (retreat) rather than blindly navigating.
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeTrapConstruction() {
    return {
        name: 'adversarial_trap_outpost',
        offset: 0,
        blocks: [
            [
                ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
                ['cobblestone', 'chest', 'air', 'cobblestone'],
                ['cobblestone', 'air', 'air', 'cobblestone'],
                ['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone'],
            ],
        ],
    };
}

export function createAdversarialTrapTargetScenario() {
    const construction = makeTrapConstruction();
    const basePos = { x: 600, y: 64, z: 600 };

    return new Scenario({
        name: 'adversarial_trap_target_benchmark',
        description: 'Adversarial: known diamond deposit exists but approach triggers creeper threat, recovery must retreat not blindly navigate.',
        initial_world: {
            inventory: {
                iron_pickaxe: 1,
                torch: 10,
                cobblestone: 20,
            },
            position: { x: 590, y: 64, z: 590 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    { name: 'diamond', pos: { x: 620, y: 12, z: 620 }, confidence: 0.9, detail: { item: 'diamond' } },
                    { name: 'iron_ore', pos: { x: 610, y: 30, z: 610 }, confidence: 0.7 },
                ],
                locations: [
                    { name: 'diamond_cache', kind: 'cache', pos: { x: 620, y: 12, z: 620 } },
                    { name: 'safe_haven', kind: 'shelter', pos: { x: 585, y: 64, z: 585 } },
                ],
                threats: [],
                structures: [
                    { name: 'diamond_ore', kind: 'deposit', pos: { x: 620, y: 12, z: 620 } },
                ],
            },
            blocks: {},
        },
        project: {
            goal: 'Locate diamond cache at (620,12,620), gather diamonds, build safe outpost',
            summary: 'Trap target — known location but dangerous approach',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Locate' },
                { title: 'Gather' },
                { title: 'Secure' },
            ],
            steps: [
                {
                    title: 'Locate diamond cache',
                    instruction: 'Navigate to diamond cache at (620,12,620) and locate diamond ore',
                    phase: 1,
                    expected: { kind: 'block_near', block: 'diamond_ore', radius: 12, atLeast: 2 },
                },
                {
                    title: 'Gather diamonds',
                    instruction: 'Mine 3 diamonds from cache',
                    phase: 2,
                    expected: { kind: 'inventory', item: 'diamond', gained: 3 },
                },
                {
                    title: 'Build trap outpost',
                    instruction: 'Build safe outpost at (600,64,600) with chest',
                    phase: 3,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 10, atLeast: 6 },
                },
                {
                    title: 'Verify outpost',
                    instruction: 'Verify outpost intact and safe',
                    phase: 3,
                    expected: { kind: 'freeform', description: 'outpost complete and safe from threats' },
                },
            ],
        },
        injected_events: [
            {
                id: 'trap_known_target',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: {
                    threat: 'creeper',
                    pos: { x: 592, y: 64, z: 592 },
                    health: 10,
                },
                description: 'Known diamond target is trapped — creeper near bot, should retreat not blindly navigate',
            },
            {
                id: 'diamond_depleted_trap',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'diamond',
                    depletedPos: { x: 620, y: 12, z: 620 },
                },
                description: 'Diamond deposit appears depleted, but threat is more urgent',
            },
            {
                id: 'secondary_threat',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 1 },
                type: EVENT_TYPES.THREATS_LOW_HEALTH,
                data: {
                    threat: 'skeleton',
                    pos: { x: 592, y: 64, z: 592 },
                    health: 8,
                },
                description: 'Second threat during diamond gathering — must prioritize safety',
            },
            {
                id: 'interruption_trap',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 0 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'creeper hiss interruption' },
            },
            {
                id: 'restart_after_trap',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 1 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'resume after retreat from trap' },
            },
            {
                id: 'outpost_damage',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepTitle: 'Build trap outpost' },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'adversarial_trap_outpost@600,64,600#0', count: 3 },
            },
        ],
        expected_recoveries: [
            {
                eventId: 'trap_known_target',
                expectedAction: 'retreat',
                expectedReason: 'danger_nearby',
                description: 'Must prioritize retreat over blind navigation to trapped target',
            },
            {
                eventId: 'diamond_depleted_trap',
                expectedAction: 'retreat',
                expectedReason: 'danger_nearby',
                description: 'Even with depleted target, safety should be prioritized — evidence should show danger_nearby not just target_depleted',
            },
            {
                eventId: 'secondary_threat',
                expectedAction: 'retreat',
                expectedReason: 'danger_nearby',
                description: 'Second threat should also trigger retreat',
            },
            {
                eventId: 'interruption_trap',
                expectedAction: 'resume',
                description: 'Should resume after trap interruption',
            },
            {
                eventId: 'outpost_damage',
                expectedAction: 'replan',
                expectedReason: 'construction_damaged',
                description: 'Damage after building should trigger replan',
            },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const adversarialTrapTargetScenario = createAdversarialTrapTargetScenario();
export default adversarialTrapTargetScenario;
