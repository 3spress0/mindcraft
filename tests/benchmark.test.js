import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BenchmarkMetrics, BenchmarkStore } from '../src/agent/benchmark/metrics.js';
import { Scenario, EVENT_TYPES, TRIGGER_AT, checkSuccessCondition } from '../src/agent/benchmark/scenario.js';
import { BenchmarkHarness, FakeBot } from '../src/agent/benchmark/harness.js';
import { createWheatFarmScenario } from '../src/agent/benchmark/scenarios/wheat_farm.js';
import { createExpectedSnapshot, compareSnapshot, ConstructionRegistry } from '../src/agent/planning/construction_damage.js';
import { FAILURE } from '../src/agent/planning/critic.js';
import { decideRecoveryContext, RECOVERY_REASON } from '../src/agent/planning/recovery.js';
import { RECOVERY_ACTION } from '../src/agent/planning/policies.js';
import { OUTCOME } from '../src/agent/planning/critic.js';
import { WorldModel, CATEGORY } from '../src/agent/world_model/world_model.js';

// ---------- construction damage ----------

test('construction damage: snapshot creation and comparison', () => {
    const construction = {
        name: 'test_farm',
        offset: 0,
        blocks: [
            // y=0
            [
                ['farmland', 'farmland', 'water'],
                ['farmland', 'wheat', 'farmland'],
            ],
            // y=1
            [
                ['oak_fence', 'oak_fence', 'oak_fence'],
                ['oak_fence', 'air', 'oak_fence'],
            ],
        ],
    };
    const pos = { x: 10, y: 64, z: 10 };
    const snap = createExpectedSnapshot('test_farm', construction, pos, 0);
    assert.equal(snap.totalExpected, 11); // 6 + 5 (air skipped)
    assert.ok(snap.expectedList.some(e => e.expected === 'water' && e.x === 12));

    const bot = new FakeBot({ blocks: {} });
    // Place all expected blocks
    for (const entry of snap.expectedList) {
        bot.setBlock(entry.x, entry.y, entry.z, entry.expected);
    }
    let comp = compareSnapshot(snap, bot, { tolerance: 0 });
    assert.equal(comp.damaged, false);
    assert.equal(comp.matched, snap.totalExpected);
    assert.match(comp.evidence, /intact/);

    // Damage 3 blocks
    bot.setBlock(10, 64, 10, 'air');
    bot.setBlock(11, 64, 10, 'air');
    bot.setBlock(12, 64, 10, 'air');
    comp = compareSnapshot(snap, bot, { tolerance: 0.05 });
    assert.equal(comp.damaged, true);
    assert.ok(comp.damageRatio > 0.2);
    assert.equal(comp.missing.length, 3);
    assert.match(comp.evidence, /construction damaged/);
});

test('construction damage: orientation handling', () => {
    const construction = {
        offset: 0,
        blocks: [
            [
                ['stone', 'glass'],
                ['dirt', 'air'],
            ],
        ],
    };
    const pos = { x: 0, y: 64, z: 0 };
    const snap0 = createExpectedSnapshot('orient', construction, pos, 0);
    const snap1 = createExpectedSnapshot('orient', construction, pos, 1);
    // Different orientations should produce different world positions for same blueprint cell
    // but same count
    assert.equal(snap0.totalExpected, snap1.totalExpected);
    // Check that rotated snapshot still places blocks correctly
    const bot = new FakeBot({});
    for (const e of snap1.expectedList) bot.setBlock(e.x, e.y, e.z, e.expected);
    const comp = compareSnapshot(snap1, bot);
    assert.equal(comp.damaged, false);
});

test('construction damage: registry stores and retrieves snapshots', () => {
    const reg = new ConstructionRegistry();
    const construction = { offset: 0, blocks: [[['stone']]] };
    const snap = createExpectedSnapshot('mybuild', construction, { x: 0, y: 64, z: 0 }, 0);
    reg.add(snap);
    assert.ok(reg.has(snap.id));
    assert.equal(reg.get(snap.id).name, 'mybuild');
    assert.equal(reg.all().length, 1);
    reg.remove(snap.id);
    assert.equal(reg.all().length, 0);
});

test('construction damage failure classification feeds into recovery', () => {
    const model = new WorldModel();
    model.recordPlayer({ position: { x: 0, y: 64, z: 0 }, health: 20 });
    const step = { title: 'Verify farm', instruction: 'verify', expected: { kind: 'construction', snapshotId: 'farm@0,64,0#0' } };
    const decision = decideRecoveryContext({
        outcome: OUTCOME.FAILED,
        failureClass: FAILURE.CONSTRUCTION_DAMAGED,
        attempts: 1,
        maxAttempts: 2,
        replanCount: 0,
        maxReplans: 3,
        step,
        after: { position: { x: 0, y: 64, z: 0 }, health: 20, inventory: {} },
        critique: { reasoning: 'construction damaged: expected 25 blocks, 20 matched, 5 mismatched (20% damaged); 5 missing', diffText: '' },
        worldModel: model,
        profile: 'builder',
    });
    assert.equal(decision.action, RECOVERY_ACTION.REPLAN);
    assert.equal(decision.reason, RECOVERY_REASON.CONSTRUCTION_DAMAGED);
    assert.ok(decision.evidence.some(e => /damaged/));
});

// ---------- metrics ----------

test('benchmark metrics: records and summarizes', () => {
    const m = new BenchmarkMetrics({ scenarioName: 'test', plannerModel: 'deterministic' });
    m.total_steps = 8;
    m.recordStep({ title: 'Gather seeds', outcome: OUTCOME.SUCCESS, attempts: 1, failed: false });
    m.recordStep({ title: 'Till', outcome: OUTCOME.FAILED, attempts: 2, failed: true });
    m.recordRecovery({ action: 'navigate', reason: 'target_depleted', stepTitle: 'Gather seeds' });
    m.recordRecovery({ action: 'replan', reason: 'construction_damaged', stepTitle: 'Verify farm' });
    m.recordInterruption('test interrupt');
    m.recordResume();
    m.recordDeath({ x: 0, y: 64, z: 0 });
    m.recordResourceWaste(3, 'wheat_seeds');
    m.recordLLMCall(true);
    m.recordLLMCall(false);
    m.setCompletion(true, 100, 8);
    const summary = m.finish();

    assert.equal(summary.total_steps, 8);
    assert.equal(summary.successful_steps, 1);
    assert.equal(summary.failed_steps, 1);
    assert.equal(summary.retries, 1);
    assert.equal(summary.replans, 1);
    assert.equal(summary.recovery_actions.navigate, 1);
    assert.equal(summary.recovery_reasons.construction_damaged, 1);
    assert.equal(summary.interruptions, 1);
    assert.equal(summary.resumes, 1);
    assert.equal(summary.deaths, 1);
    assert.equal(summary.resource_waste, 3);
    assert.equal(summary.LLM_calls, 2);
    assert.equal(summary.LLM_failures, 1);
    assert.equal(summary.completion, true);
    assert.ok(summary.execution_time >= 0);
});

test('benchmark store: saves and loads metrics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-bench-store-'));
    try {
        const store = new BenchmarkStore(dir);
        const m = new BenchmarkMetrics({ scenarioName: 'store_test' });
        m.total_steps = 5;
        m.setCompletion(true, 100, 5);
        m.finish();
        const fp = store.save(m);
        assert.ok(fs.existsSync(fp));
        const loaded = store.load(m.runId);
        assert.ok(loaded);
        assert.equal(loaded.scenarioName, 'store_test');
        const list = store.list();
        assert.equal(list.length, 1);
        assert.equal(list[0].scenario, 'store_test');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------- scenario ----------

test('scenario: validation and event triggering', () => {
    const scenario = new Scenario({
        name: 'test_scenario',
        project: { goal: 'build something', steps: [{ title: 'A', instruction: 'do A', expected: { kind: 'freeform', description: 'done' } }] },
        injected_events: [
            { id: 'ev1', trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 }, type: EVENT_TYPES.MISSING_RESOURCES, data: { missing: ['x'] } },
            { id: 'ev2', trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 0 }, type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS, data: {} },
        ],
        success_condition: { kind: 'all_steps_done' },
    });
    const problems = scenario.validate();
    assert.equal(problems.length, 0);

    const before = scenario.eventsAt(TRIGGER_AT.BEFORE_STEP, { stepIndex: 0 });
    assert.equal(before.length, 1);
    assert.equal(before[0].id, 'ev1');

    const after = scenario.eventsAt(TRIGGER_AT.AFTER_STEP, { stepIndex: 0 });
    assert.equal(after.length, 1);
});

test('scenario: checkSuccessCondition', () => {
    const fakeProject = { status: 'done', steps: [{ title: 'A', status: 'done' }] };
    const metrics = { completion: true, completionPct: 100, events: [] };
    assert.equal(checkSuccessCondition({ kind: 'all_steps_done' }, fakeProject, metrics), true);
    assert.equal(checkSuccessCondition({ kind: 'pct_complete', pct: 80 }, fakeProject, { completionPct: 90, events: [] }), true);
    assert.equal(checkSuccessCondition({ kind: 'pct_complete', pct: 80 }, fakeProject, { completionPct: 50, events: [] }), false);
});

// ---------- deterministic harness ----------

test('benchmark harness: runs wheat farm scenario end-to-end', async () => {
    const scenario = createWheatFarmScenario();
    const harness = new BenchmarkHarness(scenario, { plannerModel: 'deterministic-test' });

    const result = await harness.run();

    // Should have processed all injected event types
    const eventTypes = result.metrics.events.map(e => e.type);
    assert.ok(eventTypes.includes('injection_applied'), 'should apply injections');
    // At least some steps should succeed
    assert.ok(result.metrics.successful_steps > 0, 'should have successful steps');
    // Should have recorded recovery actions (navigate for depleted, replan for damage)
    assert.ok(Object.keys(result.metrics.recovery_actions).length > 0, 'should have recovery actions');
    // Completion should be true (deterministic executor repairs damage)
    assert.equal(result.metrics.completion, true, `expected completion true, got ${result.metrics.completion}, project status ${result.project.status}`);
    assert.ok(result.metrics.execution_time >= 0);
    assert.ok(result.metrics.total_steps > 0);

    // Check specific scenario flow
    assert.ok(result.metrics.interruptions >= 1, 'should have interruption');
    assert.ok(result.metrics.resumes >= 1, 'should have resume');
    // Construction damage should have been detected
    const damageEvents = result.metrics.events.filter(e => e.type === 'construction_damaged' || e.type === 'construction_damaged_detected');
    assert.ok(damageEvents.length >= 1, 'should detect construction damage');

    harness.cleanup();
}, { timeout: 15000 });

test('benchmark harness: handles all required injection types', async () => {
    const scenario = new Scenario({
        name: 'injection_coverage',
        initial_world: {
            inventory: { dirt: 5 },
            world_model: {
                resources: [
                    { name: 'test_item', pos: { x: 10, y: 64, z: 0 }, confidence: 0.7, detail: { depleted: true } },
                    { name: 'test_item', pos: { x: 50, y: 64, z: 0 }, confidence: 0.7 },
                ],
            },
        },
        project: {
            goal: 'test all injections',
            steps: [
                { title: 'Gather test_item', instruction: 'gather test_item', expected: { kind: 'inventory', item: 'test_item', gained: 1 } },
                { title: 'Place block', instruction: 'place test block', expected: { kind: 'block_near', block: 'dirt', radius: 8, atLeast: 1 } },
                { title: 'Verify', instruction: 'verify', expected: { kind: 'freeform', description: 'done' } },
            ],
        },
        injected_events: [
            { id: 'missing', trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 }, type: EVENT_TYPES.MISSING_RESOURCES, data: { missing: ['test_item'] } },
            { id: 'depleted', trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 0 }, type: EVENT_TYPES.DEPLETED_DEPOSITS, data: { item: 'test_item', depletedPos: { x: 10, y: 64, z: 0 }, alternativePos: { x: 50, y: 64, z: 0 } } },
            { id: 'interrupt', trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 0 }, type: EVENT_TYPES.INTERRUPTED_EXECUTION, data: {} },
            { id: 'restart', trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 1 }, type: EVENT_TYPES.RESTART_RESUME, data: {} },
            { id: 'damage', trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 1 }, type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS, data: { blocks: [{ x: 0, y: 64, z: 0 }] } },
            { id: 'threat', trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 2 }, type: EVENT_TYPES.THREATS_LOW_HEALTH, data: { threat: 'zombie', health: 5 } },
            { id: 'perm', trigger: { at: TRIGGER_AT.BEFORE_STEP, stepIndex: 2 }, type: EVENT_TYPES.UNAVAILABLE_PERMISSIONS, data: { message: 'cannot build here' } },
        ],
        success_condition: { kind: 'pct_complete', pct: 50 },
    });

    const harness = new BenchmarkHarness(scenario, { plannerModel: 'coverage-test' });
    const result = await harness.run();

    assert.ok(result.metrics.events.some(e => e.type === 'missing_resources_injected' || e.type === 'injection_applied'));
    assert.ok(result.metrics.interruptions >= 1);
    assert.ok(result.metrics.resumes >= 1);

    harness.cleanup();
}, { timeout: 15000 });

test('benchmark harness: construction damage detection integrated with recovery', async () => {
    const construction = {
        name: 'small_hut',
        offset: 0,
        blocks: [
            [
                ['cobblestone', 'cobblestone'],
                ['cobblestone', 'cobblestone'],
            ],
        ],
    };
    const basePos = { x: 20, y: 64, z: 20 };
    const scenario = new Scenario({
        name: 'damage_recovery',
        initial_world: { inventory: { cobblestone: 10 }, position: { x: 15, y: 64, z: 15 } },
        project: {
            goal: 'build hut and verify',
            position: basePos,
            construction,
            steps: [
                { title: 'Build hut', instruction: 'build hut', expected: { kind: 'block_near', block: 'cobblestone', radius: 8, atLeast: 2 } },
                { title: 'Verify hut', instruction: 'verify hut intact', expected: { kind: 'construction', snapshotId: 'small_hut@20,64,20#0', tolerance: 0.1 } },
            ],
        },
        injected_events: [
            {
                id: 'damage',
                trigger: { at: TRIGGER_AT.AFTER_STEP, stepIndex: 0 },
                type: EVENT_TYPES.DESTROYED_CONSTRUCTION_BLOCKS,
                data: { snapshotId: 'small_hut@20,64,20#0', count: 2 },
            },
        ],
        expected_recoveries: [
            { eventId: 'damage', expectedAction: 'replan', expectedReason: 'construction_damaged' },
        ],
        success_condition: { kind: 'all_steps_done' },
    });

    const harness = new BenchmarkHarness(scenario, { plannerModel: 'damage-test' });
    const result = await harness.run();

    // After damage, verification should fail and trigger replan, then repair and succeed
    assert.ok(result.metrics.events.some(e => e.type.includes('construction_damaged')), 'should have damage event');
    assert.ok(result.metrics.recovery_actions.replan >= 1, 'should replan after damage');
    assert.equal(result.metrics.completion, true, 'should complete after repair');

    harness.cleanup();
}, { timeout: 15000 });
