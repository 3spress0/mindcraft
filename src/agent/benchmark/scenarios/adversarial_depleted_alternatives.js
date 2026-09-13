/**
 * adversarial_depleted_alternatives.js — adversarial recovery test
 *
 * Primary known deposit is depleted, nearest alternative is also depleted.
 * Recovery must NOT loop navigating between dead deposits.
 * Should escalate to search/replan per existing recovery policy.
 */

import { Scenario, EVENT_TYPES, TRIGGER_AT } from '../scenario.js';

function makeSimpleConstruction() {
    return {
        name: 'adversarial_depleted_base',
        offset: 0,
        blocks: [
            [
                ['cobblestone', 'cobblestone', 'cobblestone'],
                ['cobblestone', 'furnace', 'cobblestone'],
                ['cobblestone', 'cobblestone', 'cobblestone'],
            ],
        ],
    };
}

export function createAdversarialDepletedAlternativesScenario() {
    const construction = makeSimpleConstruction();
    const basePos = { x: 300, y: 64, z: 300 };

    return new Scenario({
        name: 'adversarial_depleted_alternatives_benchmark',
        description: 'Adversarial: both primary and alternative coal deposits depleted, recovery must avoid dead-deposit loop and search/replan.',
        initial_world: {
            inventory: {
                wooden_pickaxe: 1,
                torch: 5,
            },
            position: { x: 295, y: 64, z: 295 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            world_model: {
                resources: [
                    // Both deposits start depleted — no usable alternative in initial WM
                    { name: 'coal', pos: { x: 310, y: 64, z: 300 }, confidence: 0.8, detail: { depleted: true, item: 'coal' } },
                    { name: 'coal', pos: { x: 350, y: 64, z: 310 }, confidence: 0.7, detail: { depleted: true, item: 'coal' } },
                    // Distant usable deposit not initially known, to be discovered via search
                    { name: 'iron_ore', pos: { x: 400, y: 20, z: 400 }, confidence: 0.6 },
                ],
                locations: [
                    { name: 'safe_camp', kind: 'shelter', pos: { x: 290, y: 64, z: 290 } },
                ],
                threats: [],
            },
            blocks: {},
        },
        project: {
            goal: 'Gather coal despite depleted known deposits, build furnace base',
            summary: 'Adversarial depleted chain — must search not loop',
            position: basePos,
            orientation: 0,
            construction,
            phases: [
                { title: 'Scouting' },
                { title: 'Gathering' },
                { title: 'Construction' },
            ],
            steps: [
                {
                    title: 'Locate coal vein',
                    instruction: 'Locate coal vein near (310,64,300) within 12 blocks',
                    phase: 1,
                    expected: { kind: 'block_near', block: 'coal_ore', radius: 12, atLeast: 2 },
                },
                {
                    title: 'Gather coal',
                    instruction: 'Gather 10 coal for torches and smelting',
                    phase: 2,
                    expected: { kind: 'inventory', item: 'coal', gained: 10 },
                },
                {
                    title: 'Build furnace base',
                    instruction: 'Build cobblestone furnace base at (300,64,300)',
                    phase: 3,
                    expected: { kind: 'block_near', block: 'cobblestone', radius: 10, atLeast: 5 },
                },
                {
                    title: 'Verify base',
                    instruction: 'Verify furnace base intact',
                    phase: 3,
                    expected: { kind: 'freeform', description: 'furnace base complete' },
                },
            ],
        },
        injected_events: [
            {
                id: 'primary_depleted',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'coal',
                    depletedPos: { x: 310, y: 64, z: 300 },
                },
                description: 'Primary coal deposit depleted',
            },
            {
                id: 'alternative_depleted',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 },
                type: EVENT_TYPES.DEPLETED_DEPOSITS,
                data: {
                    item: 'coal',
                    depletedPos: { x: 350, y: 64, z: 310 },
                },
                description: 'Alternative coal deposit also depleted — must not loop',
            },
            {
                id: 'interruption_search',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 1 },
                type: EVENT_TYPES.INTERRUPTED_EXECUTION,
                data: { reason: 'cave-in during coal search' },
            },
            {
                id: 'restart_after_cavein',
                trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 2 },
                type: EVENT_TYPES.RESTART_RESUME,
                data: { reason: 'resume after cave-in' },
            },
        ],
        expected_recoveries: [
            {
                eventId: 'primary_depleted',
                expectedAction: 'search',
                expectedReason: 'deposit_unknown',
                description: 'Both primary and alternative depleted — must search, not loop between dead deposits',
            },
            {
                eventId: 'alternative_depleted',
                expectedAction: 'search',
                expectedReason: 'deposit_unknown',
                description: 'When both primary and alternative depleted, must search not loop',
            },
            {
                eventId: 'interruption_search',
                expectedAction: 'resume',
                description: 'Should resume after interruption',
            },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
}

export const adversarialDepletedAlternativesScenario = createAdversarialDepletedAlternativesScenario();
export default adversarialDepletedAlternativesScenario;
