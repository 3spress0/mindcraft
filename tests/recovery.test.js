import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { WorldModel, CATEGORY, SOURCE } from '../src/agent/world_model/world_model.js';
import {
    requiredItems, nearestDeposit, threatsNear, safeRetreat,
} from '../src/agent/world_model/queries.js';
import { PlanStep } from '../src/agent/planning/project.js';
import { OUTCOME, FAILURE } from '../src/agent/planning/critic.js';
import { decideRecoveryContext, RECOVERY_REASON } from '../src/agent/planning/recovery.js';
import { RECOVERY_ACTION, resolvePolicy, POLICY_PROFILES } from '../src/agent/planning/policies.js';
import { Planner } from '../src/agent/planning/planner.js';
import { Project, ProjectStore, PROJECT, stepsFromJSON } from '../src/agent/planning/project.js';
import { PlanRunner } from '../src/agent/planning/runner.js';

const P = (x, y = 64, z = 0) => ({ x, y, z });
function capture(inv = {}, pos = P(0)) {
    return { at: Date.now(), position: pos, health: 20, food: 20, dimension: 'overworld', inventory: inv, nearbyEntities: [] };
}
function gatherStep(item = 'iron_ore', n = 32) {
    return new PlanStep({
        title: `Obtain ${n} ${item}`, instruction: `mine ${n} ${item}`,
        expected: { kind: 'inventory', item, gained: n },
    });
}

test('policy profiles resolve with settings overrides', () => {
    assert.equal(resolvePolicy('explorer')[FAILURE.TARGET_MISSING], RECOVERY_ACTION.SEARCH);
    assert.equal(resolvePolicy('default')[FAILURE.WRONG_APPROACH], RECOVERY_ACTION.REPLAN);
    assert.equal(resolvePolicy('default')[FAILURE.IMPOSSIBLE], RECOVERY_ACTION.ABORT);
    const custom = resolvePolicy('builder', { builder: { danger: 'human' } });
    assert.equal(custom[FAILURE.DANGER], 'human');
    // every profile covers every class the critic can emit
    for (const profile of Object.keys(POLICY_PROFILES)) {
        const p = resolvePolicy(profile);
        for (const cls of [FAILURE.TRANSIENT, FAILURE.NOT_OBTAINED, FAILURE.TARGET_MISSING,
            FAILURE.WRONG_APPROACH, FAILURE.DANGER, FAILURE.MISSING_RESOURCES, FAILURE.IMPOSSIBLE]) {
            assert.ok(p[cls], `${profile} missing policy for ${cls}`);
        }
    }
});

test('world queries: nearest usable deposit skips depleted; threats/retreat computed', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0), health: 20 });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: P(10), confidence: 0.7, detail: { depleted: true } });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: P(180), confidence: 0.7 });
    const { alternative, depleted } = nearestDeposit(m, 'iron_ore', P(0));
    assert.equal(Math.round(alternative.distance), 180);
    assert.equal(Math.round(depleted.distance), 10);

    m.record(CATEGORY.THREAT, { name: 'zombie', kind: 'zombie', pos: P(5) }, { expiresIn: 10 ** 8 });
    const threats = threatsNear(m, P(0), 16);
    assert.equal(threats.length, 1);

    m.record(CATEGORY.LOCATION, { name: 'home_base', kind: 'base', pos: P(-30) });
    const retreat = safeRetreat(m, P(0), { threat: threats[0].fact });
    assert.equal(retreat.name, 'home_base');
});

test('requiredItems extracts gains and exact costs from the verification contract', () => {
    const step = new PlanStep({
        title: 'craft hopper', instruction: 'craft',
        expected: { kind: 'inventory', item: 'hopper', gained: 1 },
        expectedDelta: [
            { path: 'inventory.hopper', delta: 1, mode: 'atLeast', tolerance: 0, verifiable: true },
            { path: 'inventory.iron_ingot', delta: -5, mode: 'exact', tolerance: 0, verifiable: true },
        ],
    });
    const req = requiredItems(step);
    assert.deepEqual(req.find((r) => r.source === 'gain'), { item: 'hopper', need: 1, source: 'gain' });
    assert.deepEqual(req.find((r) => r.source === 'cost'), { item: 'iron_ingot', need: 5, source: 'cost' });
});

test('depleted known source + alternative nearby -> NAVIGATE to the alternative with explicit evidence', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0), health: 20 });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: P(8), confidence: 0.7, detail: { depleted: true } });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: P(180), confidence: 0.7 });

    const step = gatherStep();
    const d = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.NOT_OBTAINED,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}, P(8)), critique: { reasoning: 'no iron gained', diffText: '' },
        worldModel: m,
    });
    assert.equal(d.action, RECOVERY_ACTION.NAVIGATE);
    assert.equal(d.reason, RECOVERY_REASON.TARGET_DEPLETED);
    assert.ok(d.evidence.some((e) => /depleted/i.test(e)));
    assert.ok(d.evidence.some((e) => /180/.test(e)));
    assert.deepEqual(d.target.pos, P(180));
    assert.match(d.guidance, /\(180, 64, 0\)/);
});

test('no known source -> SEARCH (explorer) / GATHER (default) with reason deposit_unknown', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0), health: 20 });
    const step = gatherStep('diamond');
    const base = {
        outcome: OUTCOME.FAILED, failureClass: FAILURE.NOT_OBTAINED,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'none found', diffText: '' }, worldModel: m,
    };
    const explorer = decideRecoveryContext({ ...base, profile: 'explorer' });
    assert.equal(explorer.action, RECOVERY_ACTION.SEARCH);
    const builder = decideRecoveryContext({ ...base, profile: 'builder' });
    assert.ok([RECOVERY_ACTION.GATHER, RECOVERY_ACTION.SEARCH].includes(builder.action));
});

test('search budget exhausted -> replan; replans exhausted -> human', () => {
    const m = new WorldModel();
    const step = gatherStep('diamond');
    const d = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.NOT_OBTAINED,
        attempts: 2, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'none', diffText: '' }, worldModel: m,
        profile: 'explorer',
    });
    assert.equal(d.action, RECOVERY_ACTION.REPLAN);
    assert.equal(d.reason, RECOVERY_REASON.RETRY_BUDGET_EXHAUSTED);

    const d2 = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.NOT_OBTAINED,
        attempts: 2, maxAttempts: 2, replanCount: 3, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'none', diffText: '' }, worldModel: m,
        profile: 'explorer',
    });
    assert.equal(d2.action, RECOVERY_ACTION.HUMAN);
    assert.equal(d2.reason, RECOVERY_REASON.REPLANS_EXHAUSTED);
});

test('missing materials with a known deposit navigate to it; unobtainable shortage pauses for human after budget', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0), health: 20 });
    m.record(CATEGORY.RESOURCE, { name: 'oak_log', kind: 'deposit', pos: P(25), confidence: 0.7 });
    const step = new PlanStep({
        title: 'craft chest', instruction: 'craft',
        expected: { kind: 'inventory', item: 'chest', gained: 1 },
        expectedDelta: [{ path: 'inventory.oak_log', delta: -8, mode: 'exact', tolerance: 0, verifiable: true }],
    });
    const d = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.MISSING_RESOURCES,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: "don't have enough oak_log", diffText: '' },
        worldModel: m,
    });
    assert.equal(d.action, RECOVERY_ACTION.NAVIGATE);
    assert.ok(d.guidance.includes('(25, 64, 0)'));

    // No world knowledge, attempts spent: planner gets a chance; then human.
    const empty = new WorldModel();
    const d2 = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.MISSING_RESOURCES,
        attempts: 2, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'missing ingredients', diffText: '' },
        worldModel: empty,
    });
    assert.equal(d2.action, RECOVERY_ACTION.REPLAN);
});

test('danger nearby at high health -> retreat to known safe place; critical health with nowhere to go -> human', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0), health: 12 });
    m.record(CATEGORY.THREAT, { name: 'zombie', kind: 'zombie', pos: P(4) }, { expiresIn: 10 ** 8 });
    m.record(CATEGORY.LOCATION, { name: 'shelter', kind: 'shelter', pos: P(-20) });
    const step = gatherStep();
    const d = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.DANGER,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: { ...capture({}, P(0)), health: 12 },
        critique: { reasoning: 'took damage', diffText: 'health 20 -> 12' }, worldModel: m,
    });
    assert.equal(d.action, RECOVERY_ACTION.RETREAT);
    assert.equal(d.reason, RECOVERY_REASON.DANGER_NEARBY);
    assert.deepEqual(d.target.pos, P(-20));
    assert.match(d.guidance, /Retreat/);

    const m2 = new WorldModel();
    m2.recordPlayer({ position: P(0), health: 3 });
    m2.record(CATEGORY.THREAT, { name: 'creeper', kind: 'creeper', pos: P(3) }, { expiresIn: 10 ** 8 });
    const critical = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.DANGER,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: { ...capture({}, P(0)), health: 3 },
        critique: { reasoning: 'nearly dead', diffText: '' }, worldModel: m2,
    });
    assert.equal(critical.action, RECOVERY_ACTION.HUMAN);
    assert.equal(critical.reason, RECOVERY_REASON.CRITICAL_HEALTH);
});

test('a threat seen in the world model alone triggers retreat even with a different failure class', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0), health: 10 });
    m.record(CATEGORY.THREAT, { name: 'husk', kind: 'husk', pos: P(5) }, { expiresIn: 10 ** 8 });
    const d = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.NOT_OBTAINED,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step: gatherStep(), after: { ...capture({}, P(0)), health: 10 },
        critique: { reasoning: 'nothing gained', diffText: '' }, worldModel: m,
    });
    assert.equal(d.action, RECOVERY_ACTION.RETREAT);
    assert.ok(d.evidence.some((e) => /husk/.test(e)));
});

test('path blocked repaths to objective coords; generic transient retries', () => {
    const step = new PlanStep({
        title: 'Reach outpost', instruction: 'walk',
        expected: { kind: 'near', x: 100, y: 64, z: 0, radius: 4 },
    });
    const m = new WorldModel();
    m.recordPlayer({ position: P(0) });
    const blocked = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.TRANSIENT,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}, P(20)), critique: { reasoning: 'no path, destination too far', diffText: '' },
        worldModel: m,
    });
    assert.equal(blocked.action, RECOVERY_ACTION.REPATH);
    assert.equal(blocked.reason, RECOVERY_REASON.PATH_BLOCKED);
    assert.deepEqual(blocked.target.pos, P(100));

    const glitch = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.TRANSIENT,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step: gatherStep(), after: capture({}), critique: { reasoning: 'interrupted by chunk lag', diffText: '' },
        worldModel: m, profile: 'explorer',
    });
    assert.equal(glitch.action, RECOVERY_ACTION.RETRY);
});

test('wrong approach replans; impossible aborts; permission walls pause', () => {
    const m = new WorldModel();
    const step = gatherStep();
    const wrong = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.WRONG_APPROACH,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'method failed', diffText: '' }, worldModel: m,
    });
    assert.equal(wrong.action, RECOVERY_ACTION.REPLAN);
    assert.equal(wrong.reason, RECOVERY_REASON.APPROACH_FAILED);

    const impossible = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.IMPOSSIBLE,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'creative-only item', diffText: '' }, worldModel: m,
    });
    assert.equal(impossible.action, RECOVERY_ACTION.ABORT);

    const denied = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.MISSING_RESOURCES,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'you do not have permission to build here', diffText: '' },
        worldModel: m,
    });
    assert.equal(denied.action, RECOVERY_ACTION.HUMAN);
    assert.equal(denied.reason, RECOVERY_REASON.PERMISSION_REQUIRED);
});

test('last-seen villager elsewhere -> NAVIGATE to the known sighting for target_missing', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: P(0) });
    m.record(CATEGORY.ENTITY, {
        name: 'villager', kind: 'villager', pos: P(200, 64, 50), confidence: 0.9, source: SOURCE.OBSERVED,
    }, { expiresIn: 10 ** 8 });
    const step = new PlanStep({
        title: 'Find villagers', instruction: 'search',
        expected: { kind: 'entity_near', entity: 'villager', atLeast: 2 },
    });
    const d = decideRecoveryContext({
        outcome: OUTCOME.FAILED, failureClass: FAILURE.TARGET_MISSING,
        attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3,
        step, after: capture({}), critique: { reasoning: 'no villagers nearby', diffText: '' }, worldModel: m,
    });
    assert.equal(d.action, RECOVERY_ACTION.NAVIGATE);
    assert.equal(d.reason, RECOVERY_REASON.KNOWN_TARGET_ELSEWHERE);
    assert.deepEqual(d.target.pos, P(200, 64, 50));
});

// ---------- runner integration ----------

function fakeAgent(model) {
    const chats = [];
    const agent = {
        name: 'testbot', world_model: model, observation_collector: null,
        openChat: (m) => chats.push(m), chats, shut_up: false,
        history: { add: () => {}, save: async () => {} },
        actions: { stop: async () => {} },
        self_prompter: { isActive: () => false, stop: async () => {} },
        bot: {
            health: 20, food: 20, game: { dimension: 'overworld' }, output: '',
            entity: { position: { x: 0, y: 64, z: 0, toFixed: () => '0', floored() { return { offset: () => P(0) }; } } },
            inventory: { slots: [] }, entities: {}, blockAt: () => ({ name: 'air' }),
        },
    };
    return agent;
}

test('runner: depleted deposit recovery injects navigation guidance, then succeeds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-rec-'));
    try {
        const model = new WorldModel();
        model.record(CATEGORY.RESOURCE, {
            name: 'iron_ore', kind: 'deposit', pos: P(5), confidence: 0.7, detail: { depleted: true },
        });
        model.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: P(180), confidence: 0.7 });

        const { steps } = stepsFromJSON([{
            title: 'Obtain iron', instruction: 'mine iron',
            expected: { kind: 'inventory', item: 'iron_ore', gained: 1 },
        }]);
        const project = new Project({ goal: 'iron', steps, status: PROJECT.ACTIVE });
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        planner.createPlan = async () => ({ project, warnings: [] });
        const agent = fakeAgent(model);
        const messages = [];
        let attempts = 0;
        agent.handleMessage = async (_src, msg) => {
            messages.push(msg);
            attempts += 1;
            if (attempts >= 2) agent.bot.inventory.slots = [{ name: 'iron_ore', count: 2 }];
            return true;
        };
        const runner = new PlanRunner(agent, { planner, store: new ProjectStore('testbot', dir) });
        runner.config = () => ({
            max_step_attempts: 2, max_replans: 3, max_executions: 60,
            executor_max_responses: 6, step_cooldown_ms: 0, freeform_critic: false,
            autoresume: false, recovery_profile: 'default', recovery_policies: null,
            danger_health_threshold: 6, threat_radius: 16,
        });
        await runner.start('iron');
        await runner.waitForCompletion();
        assert.equal(project.status, PROJECT.DONE);
        assert.equal(attempts, 2);
        // The second executor turn contains deterministic navigation guidance
        assert.ok(messages[1].includes('RECOVERY FROM PREVIOUS FAILURE'));
        assert.ok(messages[1].includes('(180, 64, 0)'));
        assert.ok(agent.chats.some((c) => c.includes('Recovery [default:navigate]')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runner: critical danger pauses with retreat evidence in planStatus', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-rec2-'));
    try {
        const model = new WorldModel();
        model.record(CATEGORY.THREAT, { name: 'creeper', kind: 'creeper', pos: P(3) }, { expiresIn: 10 ** 8 });
        const { steps } = stepsFromJSON([{
            title: 'Mine at night', instruction: 'mine',
            expected: { kind: 'inventory', item: 'cobblestone', gained: 1 },
        }]);
        const project = new Project({ goal: 'stone', steps, status: PROJECT.ACTIVE });
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        planner.createPlan = async () => ({ project, warnings: [] });
        const agent = fakeAgent(model);
        agent.bot.health = 3;
        agent.handleMessage = async () => true;
        const runner = new PlanRunner(agent, { planner, store: new ProjectStore('testbot', dir) });
        runner.config = () => ({
            max_step_attempts: 2, max_replans: 3, max_executions: 60,
            executor_max_responses: 6, step_cooldown_ms: 0, freeform_critic: false,
            autoresume: false, recovery_profile: 'survival', recovery_policies: null,
            danger_health_threshold: 6, threat_radius: 16,
        });
        await runner.start('stone');
        await runner.waitForCompletion();
        assert.equal(project.status, PROJECT.PAUSED);
        const status = runner.statusText();
        assert.match(status, /critical_health/);
        assert.match(status, /creeper/);
        assert.ok(agent.chats.some((c) => c.includes('!planResume')), 'blocked project tells the human how to resume');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
