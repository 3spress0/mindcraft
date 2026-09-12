import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    Project, PlanStep, ProjectStore, STEP, PROJECT,
    stepsFromJSON, projectFromGoal, hasDependencyCycle, PlanValidationError,
} from '../src/agent/planning/plan.js';
import { extractJSON, Planner } from '../src/agent/planning/planner.js';
import { captureState, stateDiff, checkExpectation } from '../src/agent/planning/observer.js';
import { Critic, decideRecovery, classifyFailure, OUTCOME, FAILURE, NEXT } from '../src/agent/planning/critic.js';
import { PlanRunner, describeExpected } from '../src/agent/planning/runner.js';

// ---------- plan model ----------

test('plan steps become runnable in dependency order', () => {
    const { steps } = stepsFromJSON([
        { title: 'A', instruction: 'do A', expected: { kind: 'freeform', description: 'a' } },
        { title: 'B', instruction: 'do B', expected: { kind: 'freeform', description: 'b' }, depends_on: ['1'] },
        { title: 'C', instruction: 'do C', expected: { kind: 'freeform', description: 'c' }, depends_on: ['1'] },
        { title: 'D', instruction: 'do D', expected: { kind: 'freeform', description: 'd' }, depends_on: ['2', '3'] },
    ]);
    const project = new Project({ goal: 'g', steps, status: PROJECT.ACTIVE });

    const first = project.nextStep();
    assert.equal(first.title, 'A');
    project.markDone(first);
    // B and C both unlocked; plan order picks B first
    assert.equal(project.nextStep().title, 'B');
    project.markDone(project.steps[1]);
    assert.equal(project.nextStep().title, 'C');
    project.markDone(project.steps[2]);
    assert.equal(project.nextStep().title, 'D');
});

test('invalid dependency references are dropped with warnings, cycles detected', () => {
    const { steps, problems } = stepsFromJSON([
        { title: 'A', instruction: 'a', depends_on: ['7'] },
        { title: 'B', instruction: 'b', depends_on: ['2'] }, // self
    ]);
    assert.equal(steps[0].dependsOn.length, 0);
    assert.ok(problems.some((p) => p.includes('invalid dependency "7"')));
    assert.ok(problems.some((p) => p.includes('invalid dependency "2"')));

    const cyclic = stepsFromJSON([
        { title: 'A', instruction: 'a' },
        { title: 'B', instruction: 'b' },
        { title: 'C', instruction: 'c' },
    ]).steps;
    cyclic[0].dependsOn = [cyclic[1].id];
    cyclic[1].dependsOn = [cyclic[0].id];
    assert.ok(hasDependencyCycle(cyclic));
});

test('project validation rejects empty plans, accepts good ones', () => {
    assert.throws(() => projectFromGoal('g', { steps: [] }), PlanValidationError);
    const { project } = projectFromGoal('g', {
        summary: 's', completion_criteria: 'c',
        steps: [{ title: 'A', instruction: 'do A', expected: { kind: 'inventory', item: 'dirt', atLeast: 1 } }],
    });
    assert.equal(project.status, PROJECT.ACTIVE);
    assert.equal(project.steps[0].expected.kind, 'inventory');
});

test('replanning keeps completed steps and drops dependencies on removed steps', () => {
    const { steps } = stepsFromJSON([
        { title: 'A', instruction: 'a' },
        { title: 'B', instruction: 'b', depends_on: ['1'] },
        { title: 'C', instruction: 'c', depends_on: ['2'] },
    ]);
    const project = new Project({ goal: 'g', steps, status: PROJECT.ACTIVE });
    project.markDone(project.steps[0]);
    project.markActive(project.steps[1]);

    const replacement = stepsFromJSON([
        { title: 'B2', instruction: 'b2', depends_on: ['1'] }, // ordinal 1 in new list is itself -> dropped
    ]).steps;
    project.replaceRemaining(replacement, 'wrong_approach');
    assert.equal(project.steps.length, 2);
    assert.equal(project.steps[0].title, 'A');
    assert.equal(project.steps[1].title, 'B2');
    assert.equal(project.steps[1].dependsOn.length, 0); // dangling ref removed
    assert.equal(project.iteration, 2);
});

test('progress and completion status update as steps finish', () => {
    const { steps } = stepsFromJSON([
        { title: 'A', instruction: 'a' }, { title: 'B', instruction: 'b' },
    ]);
    const project = new Project({ goal: 'g', steps });
    assert.deepEqual(project.progress(), { total: 2, done: 0, pct: 0 });
    project.markDone(project.steps[0]);
    assert.equal(project.progress().pct, 50);
    project.markDone(project.steps[1]);
    assert.equal(project.status, PROJECT.DONE);
    assert.equal(project.progress().pct, 100);
});

test('project store round-trips through JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-plan-'));
    try {
        const store = new ProjectStore('testbot', dir);
        assert.equal(store.load(), null);
        const { project } = projectFromGoal('find diamonds', {
            steps: [
                { title: 'dig down', instruction: 'dig to y -58', expected: { kind: 'near', x: 0, y: -58, z: 0, radius: 4 } },
                { title: 'mine diamonds', instruction: 'branch mine', expected: { kind: 'inventory', item: 'diamond', atLeast: 3 } },
            ],
        });
        store.save(project);
        const loaded = store.load();
        assert.equal(loaded.goal, 'find diamonds');
        assert.equal(loaded.steps.length, 2);
        assert.equal(loaded.steps[1].expected.item, 'diamond');
        store.clear();
        assert.equal(store.load(), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------- planner parsing ----------

test('extractJSON tolerates fences and prose', () => {
    assert.deepEqual(extractJSON('here:\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJSON('```\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJSON('noise {"steps":[]} trailing'), { steps: [] });
    assert.throws(() => extractJSON('no json at all'));
});

test('planner creates a project from valid model JSON, retrying on garbage', async () => {
    let calls = 0;
    const sendRequest = async () => {
        calls += 1;
        if (calls === 1) return 'sorry I cannot';
        return JSON.stringify({
            summary: 'gather then craft',
            completion_criteria: 'has a crafting table',
            steps: [
                { title: 'Get wood', instruction: 'punch oak trees for 4 logs', expected: { kind: 'inventory', item: 'oak_log', gained: 4 } },
                { title: 'Craft table', instruction: 'craft and place a crafting table', expected: { kind: 'block_near', block: 'crafting_table', radius: 8 } },
            ],
        });
    };
    const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest });
    const { project, warnings } = await planner.createPlan('make a crafting table', { attempts: 2 });
    assert.equal(calls, 2);
    assert.equal(project.steps.length, 2);
    assert.equal(project.steps[1].expected.kind, 'block_near');
    assert.deepEqual(warnings, []);
});

test('planner falls back to a single step when model output stays unusable', async () => {
    const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: async () => 'still not json' });
    const { project, warnings } = await planner.createPlan('do something', { attempts: 2 });
    assert.equal(project.steps.length, 1);
    assert.equal(project.steps[0].expected.kind, 'freeform');
    assert.ok(warnings[0].includes('fallback'));
});

test('replan returns remaining steps or declares the goal impossible', async () => {
    const { steps } = stepsFromJSON([
        { title: 'A', instruction: 'a' }, { title: 'B', instruction: 'b' },
    ]);
    const project = new Project({ goal: 'g', steps, status: PROJECT.ACTIVE });
    project.markDone(project.steps[0]);

    const plannerOk = new Planner({ prompter: {}, bot: {} }, {
        sendRequest: async () => JSON.stringify({
            summary: 'different approach',
            steps: [{ title: 'B2', instruction: 'b2', expected: { kind: 'freeform', description: 'done' } }],
        }),
    });
    const result = await plannerOk.replan(project, steps[1], { outcome: 'failed', failureClass: 'target_missing', reasoning: 'no cave nearby', diffText: '' }, { attempts: 1 });
    assert.equal(result.steps.length, 1);
    assert.equal(result.summary, 'different approach');

    const plannerNo = new Planner({ prompter: {}, bot: {} }, {
        sendRequest: async () => JSON.stringify({ impossible: true, reason: 'requires creative flight' }),
    });
    const result2 = await plannerNo.replan(project, steps[1], { failureClass: 'impossible', reasoning: '' }, { attempts: 1 });
    assert.equal(result2.impossible, true);
    assert.match(result2.reason, /creative flight/);
});

// ---------- observer / critic ----------

function fakeBot({ slots = [], entities = {}, blocks = {}, position = { x: 0, y: 64, z: 0 }, health = 20, food = 20 } = {}) {
    const pos = { x: position.x, y: position.y, z: position.z, toFixed: () => '0', floored() { return { offset: (dx, dy, dz) => ({ x: this.x + dx, y: this.y + dy, z: this.z + dz }) }; } };
    return {
        health, food,
        game: { dimension: 'overworld' },
        entity: { position: { ...pos, floored() { return { offset: (dx, dy, dz) => ({ x: position.x + dx, y: position.y + dy, z: position.z + dz }) }; } } },
        inventory: { slots },
        entities,
        blockAt: (p) => blocks.has?.(`${p.x},${p.y},${p.z}`) ? { name: blocks.get(`${p.x},${p.y},${p.z}`) } : { name: 'air' },
    };
}

test('stateDiff reports inventory gains/losses, movement and health change', () => {
    const before = {
        position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { dirt: 2 },
        nearbyEntities: [], nearbyBlockTypes: ['stone'],
    };
    const after = {
        position: { x: 10, y: 64, z: 0 }, health: 14, food: 18, inventory: { dirt: 5, oak_log: 1 },
        nearbyEntities: [{ name: 'zombie' }], nearbyBlockTypes: ['stone', 'dirt'],
    };
    const diff = stateDiff(before, after);
    assert.equal(diff.inventoryGained.dirt, 3);
    assert.equal(diff.inventoryGained.oak_log, 1);
    assert.ok(diff.moved >= 9);
    assert.equal(diff.healthDelta, -6);
    assert.match(diff.text, /oak_log \+1/);
    assert.match(diff.text, /zombie x1/);
});

test('deterministic expectations: inventory, near, block, entity, health', () => {
    const agent = {
        bot: fakeBot({
            slots: [{ name: 'iron_ore', count: 3 }],
            entities: { 1: { name: 'villager', position: { distanceTo: () => 5 } } },
            blocks: new Map([['2,64,0', 'crafting_table']]),
        }),
    };
    const before = { position: { x: 0, y: 64, z: 0 }, inventory: { iron_ore: 0 }, health: 20 };
    const after = captureState(agent);
    after.position = { x: 1, y: 64, z: 1 };

    let r = checkExpectation(agent, { kind: 'inventory', item: 'iron_ore', gained: 2 }, before, after);
    assert.equal(r.satisfied, true, r.evidence);
    r = checkExpectation(agent, { kind: 'inventory', item: 'iron_ore', gained: 10 }, before, after);
    assert.equal(r.satisfied, false);
    r = checkExpectation(agent, { kind: 'near', x: 2, y: 64, z: 1, radius: 2 }, before, after);
    assert.equal(r.satisfied, true, r.evidence);
    r = checkExpectation(agent, { kind: 'near', x: 50, y: 64, z: 0, radius: 3 }, before, after);
    assert.equal(r.satisfied, false);
    r = checkExpectation(agent, { kind: 'block_near', block: 'crafting_table', radius: 4 }, before, after);
    assert.equal(r.satisfied, true, r.evidence);
    r = checkExpectation(agent, { kind: 'entity_near', entity: 'villager', radius: 16 }, before, after);
    assert.equal(r.satisfied, true, r.evidence);
    r = checkExpectation(agent, { kind: 'entity_near', entity: 'creeper', radius: 16 }, before, after);
    assert.equal(r.satisfied, false);
    r = checkExpectation(agent, { kind: 'health_above', level: 18 }, before, after);
    assert.equal(r.satisfied, true);
    r = checkExpectation(agent, { kind: 'freeform', description: 'something vague' }, before, after);
    assert.equal(r.decidable, false);
});

test('failure classifier maps evidence to recovery classes', () => {
    assert.equal(classifyFailure({ stepText: 'gather iron', diff: { inventoryGained: {}, moved: 0 }, resultText: '' }), FAILURE.NOT_OBTAINED);
    assert.equal(classifyFailure({ stepText: 'find a village', diff: {}, resultText: 'could not find village nearby' }), FAILURE.TARGET_MISSING);
    assert.equal(classifyFailure({ stepText: 'walk', diff: { healthDelta: -8 }, resultText: '' }), FAILURE.DANGER);
    assert.equal(classifyFailure({ stepText: 'craft', diff: {}, resultText: "don't have enough iron ingot" }), FAILURE.MISSING_RESOURCES);
    assert.equal(classifyFailure({ stepText: 'go', diff: {}, resultText: 'no path, destination unreachable' }), FAILURE.TRANSIENT);
});

test('recovery policy bounds retries, replans and escalations', () => {
    const base = { outcome: OUTCOME.FAILED, failureClass: FAILURE.TRANSIENT, attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3 };
    assert.equal(decideRecovery(base), NEXT.RETRY);
    assert.equal(decideRecovery({ ...base, attempts: 2, failureClass: FAILURE.TRANSIENT }), NEXT.REPLAN);
    assert.equal(decideRecovery({ ...base, failureClass: FAILURE.MISSING_RESOURCES }), NEXT.HUMAN);
    assert.equal(decideRecovery({ ...base, failureClass: FAILURE.IMPOSSIBLE }), NEXT.ABORT);
    assert.equal(decideRecovery({ ...base, attempts: 2, replanCount: 3, failureClass: FAILURE.WRONG_APPROACH }), NEXT.HUMAN);
    assert.equal(decideRecovery({ outcome: OUTCOME.SUCCESS, failureClass: FAILURE.NONE, attempts: 1, maxAttempts: 2, replanCount: 0, maxReplans: 3 }), NEXT.CONTINUE);
});

test('critic uses deterministic checks without model calls', async () => {
    const critic = new Critic({ bot: fakeBot({ slots: [{ name: 'cobblestone', count: 10 }] }) });
    const step = new PlanStep({ title: 'mine cobble', expected: { kind: 'inventory', item: 'cobblestone', gained: 5 } });
    const before = { position: { x: 0, y: 64, z: 0 }, inventory: { cobblestone: 2 }, health: 20, nearbyEntities: [], nearbyBlockTypes: [] };
    const verdict = await critic.evaluate(step, before, null, '');
    // null after -> decidable fail
    assert.equal(verdict.outcome, OUTCOME.FAILED);
});

test('freeform critic judges via injected model, then falls back when it errors', async () => {
    let called = 0;
    const sendRequest = async () => {
        called += 1;
        if (called === 1) return '```json\n{"verdict":"success","reasoning":"house walls present","failure_class":"none"}\n```';
        throw new Error('boom');
    };
    const critic = new Critic({
        bot: fakeBot({ slots: [] }),
        prompter: { chat_model: { sendRequest: async (...args) => sendRequest(...args) } },
    }, { sendRequest });
    const step = new PlanStep({ title: 'build wall', expected: { kind: 'freeform', description: 'a 3-wide cobblestone wall' } });
    const before = { position: { x: 0, y: 64, z: 0 }, inventory: {}, health: 20, nearbyEntities: [], nearbyBlockTypes: [] };
    const after = { position: { x: 0, y: 64, z: 0 }, inventory: {}, health: 20, nearbyEntities: [], nearbyBlockTypes: ['cobblestone_wall'] };
    let v = await critic.evaluate(step, before, after, '');
    assert.equal(v.outcome, OUTCOME.SUCCESS);
    assert.match(v.reasoning, /walls present/);

    const critic2 = new Critic({ bot: fakeBot({ slots: [] }), prompter: {} }, { sendRequest: async () => { throw new Error('x'); } });
    v = await critic2.evaluate(step, before, after, 'action completed successfully');
    assert.ok([OUTCOME.SUCCESS, OUTCOME.FAILED].includes(v.outcome));
});

// ---------- runner end-to-end with fakes ----------

function makeFakeAgent({ handleMessage, botOverrides = {} } = {}) {
    const chats = [];
    const agent = {
        name: 'testbot',
        openChat: (m) => chats.push(m),
        chats,
        shut_up: false,
        history: { add: () => {}, save: async () => {} },
        actions: { stop: async () => {} },
        self_prompter: { isActive: () => false, stop: async () => {} },
        bot: { health: 20, output: '', ...botOverrides },
        handleMessage: handleMessage || (async () => true),
    };
    return agent;
}

test('runner executes and verifies every step, then completes the project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-run-'));
    try {
        const planJSON = JSON.stringify({
            summary: 'test',
            steps: [
                { title: 'Get logs', instruction: 'get 2 oak logs', expected: { kind: 'inventory', item: 'oak_log', gained: 2 } },
                { title: 'At spot', instruction: 'walk to marker', expected: { kind: 'near', x: 5, y: 64, z: 0, radius: 2 } },
            ],
        });
        const planner = new Planner({ prompter: {}, bot: {} }, {
            sendRequest: async (messages, system) => {
                // planner vs critic disambiguated by system prompt content
                if (system.includes('verifier')) return JSON.stringify({ verdict: 'success', reasoning: 'ok', failure_class: 'none' });
                return planJSON;
            },
        });
        const agent = makeFakeAgent();
        let step = 0;
        const slots = [[], [{ name: 'oak_log', count: 2 }], [{ name: 'oak_log', count: 2 }]];
        const bot = {
            health: 20, food: 20, game: { dimension: 'overworld' },
            entity: { position: { x: 0, y: 64, z: 0, toFixed: () => '0', floored() { return { offset: (dx, dy, dz) => ({ x: this.x + dx, y: this.y + dy, z: this.z + dz }) }; } } },
            inventory: { slots: [] },
            entities: {}, blockAt: () => ({ name: 'air' }), output: '',
        };
        agent.bot = bot;
        agent.handleMessage = async () => {
            step += 1;
            if (step === 1) bot.inventory.slots = slots[1];
            if (step === 2) bot.entity.position.x = 5;
            return true;
        };
        const critic = new Critic(agent);
        const store = new ProjectStore('testbot', dir);
        const runner = new PlanRunner(agent, { planner, critic, store });
        const res = await runner.start('two verifiable steps');
        assert.equal(res.ok, true);
        await runner.waitForCompletion();
        assert.equal(agent.chats.filter((c) => c.includes('Project complete')).length, 1);
        assert.equal(store.load(), null); // finished project is cleared
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runner retries then replans on persistent failure, new plan succeeds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-run2-'));
    try {
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        // initial plan: one inventory step that will never verify
        const { project } = projectFromGoal('g', {
            steps: [{ title: 'get diamonds', instruction: 'mine diamonds', expected: { kind: 'inventory', item: 'diamond', gained: 1 } }],
        });
        planner.createPlan = async () => ({ project, warnings: [] });
        planner.replan = async () => ({
            steps: stepsFromJSON([
                { title: 'do anything', instruction: 'just do something useful', expected: { kind: 'freeform', description: 'goal achieved' } },
            ]).steps,
        });
        // critic: deterministic step fails; freeform step judged successful
        let judgeCalls = 0;
        const critic = new Critic({ bot: { health: 20 } }, {
            sendRequest: async () => {
                judgeCalls += 1;
                return JSON.stringify({ verdict: 'success', reasoning: 'acceptable', failure_class: 'none' });
            },
        });
        const agent = makeFakeAgent();
        agent.bot = {
            health: 20, food: 20, game: { dimension: 'overworld' }, output: '',
            entity: { position: { x: 0, y: 64, z: 0, toFixed: () => '0', floored() { return { offset: () => ({ x: 0, y: 64, z: 0 }) }; } } },
            inventory: { slots: [] }, entities: {}, blockAt: () => ({ name: 'air' }),
        };
        const store = new ProjectStore('testbot', dir);
        const runner = new PlanRunner(agent, { planner, critic, store });

        await runner.start('g');
        await runner.waitForCompletion();
        assert.ok(judgeCalls >= 1, 'freeform critic judged replanned step');
        assert.equal(project.status, PROJECT.DONE);
        assert.equal(project.iteration, 2, 'plan was revised once');
        assert.ok(agent.chats.some((c) => c.includes('Replanning')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runner blocks for missing resources and resumes after human intervention', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-run3-'));
    try {
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        const { project } = projectFromGoal('g', {
            steps: [{ title: 'craft reactor', instruction: 'craft it', expected: { kind: 'inventory', item: 'netherite_block', atLeast: 1 } }],
        });
        planner.createPlan = async () => ({ project, warnings: [] });
        const critic = new Critic({ bot: { health: 20 } }, { sendRequest: null });
        // override evaluate to report missing-resources failure
        critic.evaluate = async () => ({
            outcome: OUTCOME.FAILED, failureClass: FAILURE.MISSING_RESOURCES,
            reasoning: 'no netherite available', diffText: '', evidence: null,
        });
        const agent = makeFakeAgent();
        agent.bot = {
            health: 20, food: 20, game: {}, output: "don't have netherite_block",
            entity: { position: { x: 0, y: 64, z: 0, toFixed: () => '0', floored() { return { offset: () => ({ x: 0, y: 64, z: 0 }) }; } } },
            inventory: { slots: [] }, entities: {}, blockAt: () => ({ name: 'air' }),
        };
        const store = new ProjectStore('testbot', dir);
        const runner = new PlanRunner(agent, { planner, critic, store });
        await runner.start('g');
        await runner.waitForCompletion();

        assert.equal(project.status, PROJECT.PAUSED);
        assert.ok(agent.chats.some((c) => c.includes('!planResume')));
        assert.ok(store.load(), 'paused project persisted');

        // Human "fixes" it: critic now succeeds; resume clears the block.
        critic.evaluate = async () => ({
            outcome: OUTCOME.SUCCESS, failureClass: FAILURE.NONE,
            reasoning: 'now have it', diffText: '', evidence: 'have 1 netherite_block',
        });
        const result = await runner.resume();
        assert.equal(result.ok, true);
        await runner.waitForCompletion();
        assert.equal(project.status, PROJECT.DONE);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('planStop pauses mid-step and persists, planResume continues', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-run4-'));
    try {
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        const { project } = projectFromGoal('g', {
            steps: [
                { title: 'A', instruction: 'a', expected: { kind: 'inventory', item: 'dirt', gained: 1 } },
                { title: 'B', instruction: 'b', expected: { kind: 'inventory', item: 'stone', gained: 1 } },
            ],
        });
        planner.createPlan = async () => ({ project, warnings: [] });
        const critic = new Critic({ bot: { health: 20 } }, { sendRequest: null });
        const agent = makeFakeAgent();
        agent.abortActiveLLMRequest = () => {};
        agent.bot = {
            health: 20, food: 20, game: {}, output: '',
            entity: { position: { x: 0, y: 64, z: 0, toFixed: () => '0', floored() { return { offset: () => ({ x: 0, y: 64, z: 0 }) }; } } },
            inventory: { slots: [] }, entities: {}, blockAt: () => ({ name: 'air' }),
        };
        // First step's executor hangs until the runner signals interrupt.
        let released;
        const gate = new Promise((r) => { released = r; });
        let executions = 0;
        agent.handleMessage = async () => {
            executions += 1;
            if (executions === 1) {
                await gate;
                return false;
            }
            agent.bot.inventory.slots = [{ name: 'dirt', count: 1 }, { name: 'stone', count: 1 }];
            return true;
        };
        const store = new ProjectStore('testbot', dir);
        const runner = new PlanRunner(agent, { planner, critic, store });
        runner.config = () => ({
            max_step_attempts: 2, max_replans: 3, max_executions: 60,
            executor_max_responses: 6, step_cooldown_ms: 0, freeform_critic: false, autoresume: true,
        });
        await runner.start('g');
        await new Promise((r) => setTimeout(r, 50));
        const stopPromise = runner.stop({ pause: true });
        released();
        await stopPromise;

        assert.equal(project.status, PROJECT.PAUSED);
        const persisted = store.load();
        assert.ok(persisted, 'paused project was persisted');
        assert.equal(persisted.status, PROJECT.PAUSED);

        // After resume, deterministic checks succeed (inventory now stocked).
        critic.evaluate = async (step) => ({
            outcome: OUTCOME.SUCCESS, failureClass: FAILURE.NONE, reasoning: 'have items',
            diffText: '', evidence: `got ${step.title}`,
        });
        agent.handleMessage = async () => true;
        await runner.resume();
        await runner.waitForCompletion();
        assert.equal(project.status, PROJECT.DONE);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('describeExpected renders every verification kind readably', () => {
    assert.match(describeExpected({ kind: 'inventory', item: 'dirt', gained: 3 }), /gains at least 3x dirt/);
    assert.match(describeExpected({ kind: 'near', x: 1, y: 2, z: 3, radius: 5 }), /within 5 blocks/);
    assert.match(describeExpected({ kind: 'entity_near', entity: 'cow', radius: 10 }), /cow within 10/);
    assert.match(describeExpected({ kind: 'freeform', description: 'door opens' }), /door opens/);
});
