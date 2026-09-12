import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'node:events';

import {
    normalizeDelta, checkTransition, describeDelta, deltaToJSON, readPath,
} from '../src/agent/observation/transitions.js';
import { Critic, OUTCOME, FAILURE } from '../src/agent/planning/critic.js';
import { PlanStep, stepsFromJSON, Project, PROJECT, ProjectStore } from '../src/agent/planning/plan.js';
import { Planner } from '../src/agent/planning/planner.js';
import { PlanRunner } from '../src/agent/planning/runner.js';
import { WorldModel, CATEGORY } from '../src/agent/world_model/world_model.js';
import { WorldModelStore } from '../src/agent/world_model/store.js';
import { ObservationCollector } from '../src/agent/observation/collector.js';
import { ingestVerifiedStep } from '../src/agent/observation/ingest.js';

// ---------- transition specs ----------

test('normalizeDelta: signed map, object specs and unknown paths', () => {
    const { entries, problems } = normalizeDelta({
        'inventory.hopper': 1,
        'inventory.iron_ingot': -5,
        'inventory.stick': { delta: -8, tolerance: 1 },
        'temperature': 2,
    });
    assert.equal(entries.length, 4);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    assert.equal(byPath['inventory.hopper'].mode, 'atLeast');
    assert.equal(byPath['inventory.iron_ingot'].mode, 'exact');
    assert.equal(byPath['inventory.stick'].tolerance, 1);
    assert.equal(byPath['temperature'].verifiable, false);
    assert.ok(problems.some((p) => p.includes('not verifiable')));

    const invalid = normalizeDelta({ 'inventory.x': 'many' });
    assert.equal(invalid.entries.length, 0);
    assert.ok(invalid.problems.length);
});

test('checkTransition: exact craft cost verified, and "LLM says success" without delta fails', () => {
    const before = { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { iron_ingot: 5 } };
    const afterCraft = { ...before, inventory: { hopper: 1 } };
    const afterNothing = { ...before, inventory: { iron_ingot: 5 } };
    const spec = normalizeDelta({ 'inventory.hopper': 1, 'inventory.iron_ingot': -5 });

    const ok = checkTransition(spec, before, afterCraft);
    assert.equal(ok.decidable, true);
    assert.equal(ok.satisfied, true);

    const fail = checkTransition(spec, before, afterNothing);
    assert.equal(fail.satisfied, false);
    assert.ok(fail.evidence.includes('MISMATCH'));
    assert.ok(fail.results.some((r) => r.path === 'inventory.hopper' && r.actual === 0));

    // consuming 6 iron when 5 expected is resource waste -> exact fails, tolerance passes
    const over = checkTransition(spec, before, { ...before, inventory: { iron_ingot: -1, hopper: 1 } });
    assert.equal(over.satisfied, false, 'over-consumption must be flagged');
    // 6 iron consumed (one wasted): exact fails above, tolerance 1 accepts
    const before6 = { ...before, inventory: { iron_ingot: 6 } };
    const tolerant = checkTransition(
        normalizeDelta({ 'inventory.hopper': 1, 'inventory.iron_ingot': { delta: -5, tolerance: 1 } }),
        before6, { ...before6, inventory: { hopper: 1 } }
    );
    assert.equal(tolerant.satisfied, true);
});

test('checkTransition: positive deltas are atLeast (extra gains fine), scalars supported', () => {
    const before = { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: { cobblestone: 0 } };
    const after = { ...before, inventory: { cobblestone: 9 } };
    const r = checkTransition(normalizeDelta({ 'inventory.cobblestone': 3 }), before, after);
    assert.equal(r.satisfied, true);

    const hp = checkTransition(normalizeDelta({ health: -2 }), before, { ...before, health: 18 });
    assert.equal(hp.satisfied, true);
    const hpBad = checkTransition(normalizeDelta({ health: -2 }), before, { ...before, health: 10 });
    assert.equal(hpBad.satisfied, false);

    assert.equal(readPath(after, 'food'), 20);
    assert.equal(readPath(after, 'inventory.missing'), 0);
});

test('checkTransition: empty/undecidable and no post-state', () => {
    const cap = { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: {} };
    assert.equal(checkTransition(null, cap, cap).decidable, false);
    const gone = checkTransition(normalizeDelta({ 'inventory.x': 1 }), cap, null);
    assert.equal(gone.decidable, true);
    assert.equal(gone.satisfied, false);
});

test('describeDelta and JSON round-trip', () => {
    const spec = normalizeDelta({ 'inventory.hopper': 1, 'inventory.iron_ingot': -5 });
    assert.match(describeDelta(spec), /hopper \+1 or more/);
    assert.match(describeDelta(spec), /iron_ingot -5/);
    const json = deltaToJSON(spec.entries);
    assert.deepEqual(json, { 'inventory.hopper': 1, 'inventory.iron_ingot': -5 });
});

// ---------- plan model carries transition contracts ----------

test('plans parse, persist and rehydrate expected_delta', () => {
    const { steps } = stepsFromJSON([{
        title: 'Craft hopper', instruction: 'craft one hopper',
        expected: { kind: 'inventory', item: 'hopper', gained: 1 },
        expected_delta: { 'inventory.hopper': 1, 'inventory.iron_ingot': -5 },
    }]);
    assert.equal(steps[0].expectedDelta.length, 2);
    const json = JSON.parse(JSON.stringify(steps[0].toJSON()));
    assert.equal(json.expected_delta['inventory.iron_ingot'], -5);
    const rehydrated = new PlanStep(json);
    assert.equal(rehydrated.expectedDelta.find((e) => e.path === 'inventory.hopper').delta, 1);
});

// ---------- critic integration ----------

function makeCriticAgent() {
    return { bot: { health: 20 }, prompter: { chat_model: {} } };
}
function capture(inv = {}, pos = { x: 0, y: 64, z: 0 }) {
    return { at: Date.now(), position: pos, health: 20, food: 20, dimension: 'overworld', inventory: inv, nearbyEntities: [] };
}

test('critic: unmet state transition fails deterministically even when executor reports success, no model call', async () => {
    let modelCalls = 0;
    const critic = new Critic(makeCriticAgent(), { sendRequest: async () => { modelCalls += 1; return '{}'; } });
    const step = new PlanStep({
        title: 'Craft a hopper',
        instruction: 'craft hopper from 5 iron and a chest',
        expected: { kind: 'freeform', description: 'hopper crafted' },
        expectedDelta: normalizeDelta({ 'inventory.hopper': 1, 'inventory.iron_ingot': -5 }).entries,
    });
    const before = capture({ iron_ingot: 5 });
    const after = capture({ iron_ingot: 5 }); // executor lied: nothing changed
    const v = await critic.evaluate(step, before, after, 'I successfully crafted the hopper.');
    assert.equal(v.outcome, OUTCOME.FAILED);
    assert.equal(v.failureClass, FAILURE.NOT_OBTAINED);
    assert.ok(v.reasoning.includes('state transition'));
    assert.equal(modelCalls, 0, 'deterministic mismatch must not call the model');
});

test('critic: satisfied transition with freeform expectation succeeds without the model', async () => {
    let modelCalls = 0;
    const critic = new Critic(makeCriticAgent(), { sendRequest: async () => { modelCalls += 1; return '{}'; } });
    const step = new PlanStep({
        title: 'Craft a hopper',
        instruction: 'craft it',
        expected: { kind: 'freeform', description: 'hopper crafted' },
        expectedDelta: normalizeDelta({ 'inventory.hopper': 1, 'inventory.iron_ingot': -5 }).entries,
    });
    const before = capture({ iron_ingot: 5 });
    const after = capture({ hopper: 1 });
    const v = await critic.evaluate(step, before, after, 'done');
    assert.equal(v.outcome, OUTCOME.SUCCESS);
    assert.equal(modelCalls, 0);
    assert.ok(v.transition.satisfied);
});

test('critic: expectation and transition both must pass', async () => {
    const critic = new Critic(makeCriticAgent(), { sendRequest: null });
    const step = new PlanStep({
        title: 'Get 2 logs', instruction: 'mine logs',
        expected: { kind: 'inventory', item: 'oak_log', gained: 2 },
        expectedDelta: normalizeDelta({ 'inventory.oak_log': 2 }).entries,
    });
    const before = capture({});
    const onlyOne = capture({ oak_log: 1 });
    const v = await critic.evaluate(step, before, onlyOne, '');
    assert.equal(v.outcome, OUTCOME.FAILED);
    assert.match(v.reasoning, /gained 1/);
});

// ---------- verified-step ingestion ----------

test('ingest: gather success records a resource deposit at the work site', () => {
    const model = new WorldModel();
    const step = new PlanStep({
        title: 'Mine iron ore', instruction: 'mine the exposed iron vein',
        expected: { kind: 'inventory', item: 'iron_ore', gained: 2 },
        expectedDelta: normalizeDelta({ 'inventory.iron_ore': 2 }).entries,
    });
    const after = capture({ iron_ore: 3 }, { x: 12, y: 40, z: -7 });
    ingestVerifiedStep(model, {
        step, before: capture({}), after,
        critique: { outcome: OUTCOME.SUCCESS, evidence: 'gained 3 iron_ore' },
    });
    const hit = model.queryNearest('iron deposit', { x: 0, y: 40, z: 0 });
    assert.ok(hit);
    assert.equal(hit.fact.name, 'iron_ore');
    assert.equal(hit.fact.pos.x, 12);
});

test('ingest: simultaneous materials loss + product gain proves a recipe', () => {
    const model = new WorldModel();
    const step = new PlanStep({
        title: 'Craft a hopper', instruction: 'craft hopper',
        expected: { kind: 'inventory', item: 'hopper', gained: 1 },
        expectedDelta: normalizeDelta({ 'inventory.hopper': 1, 'inventory.iron_ingot': -5, 'inventory.chest': -1 }).entries,
    });
    const before = capture({ iron_ingot: 5, chest: 1 });
    const after = capture({ hopper: 1 });
    ingestVerifiedStep(model, {
        step, before, after, critique: { outcome: OUTCOME.SUCCESS, evidence: 'found materials' },
    });
    assert.ok(model.hasRecipe('hopper'));
});

test('ingest: two villagers infer a village; hostiles are always recorded', () => {
    const model = new WorldModel();
    const step = new PlanStep({
        title: 'Find village', instruction: 'locate a village',
        expected: { kind: 'entity_near', entity: 'villager', atLeast: 2 },
    });
    const after = capture({}, { x: 200, y: 64, z: 200 });
    after.nearbyEntities = [
        { name: 'villager', type: 'mob', x: 201, y: 64, z: 200 },
        { name: 'villager', type: 'mob', x: 203, y: 64, z: 202 },
        { name: 'zombie', type: 'mob', x: 199, y: 64, z: 199 },
    ];
    ingestVerifiedStep(model, {
        step, before: capture({}, { x: 198, y: 64, z: 198 }), after,
        critique: { outcome: OUTCOME.SUCCESS, evidence: 'found 2 "villager" within 24 blocks OK' },
    });
    const village = model.lastSeen('village', [CATEGORY.LOCATION]);
    assert.ok(village, 'inferred village location');
    assert.equal(model.all(CATEGORY.THREAT).length, 1);
    assert.equal(model.all(CATEGORY.ENTITY).length, 2);

    // A later planner can ask for it directly
    const hit = model.queryNearest('where is the village', { x: 0, y: 64, z: 0 });
    assert.equal(hit.category, CATEGORY.LOCATION);
});

test('ingest: verified block placement becomes a durable structure fact', () => {
    const model = new WorldModel();
    const step = new PlanStep({
        title: 'Place crafting table', instruction: 'put table down',
        expected: { kind: 'block_near', block: 'crafting_table', radius: 8 },
    });
    const after = capture({}, { x: 3, y: 64, z: 3 });
    ingestVerifiedStep(model, {
        step, before: capture({}), after,
        critique: { outcome: OUTCOME.SUCCESS, evidence: 'found 1 "crafting_table" block(s) within 8 blocks' },
    });
    const s = model.all(CATEGORY.STRUCTURE);
    assert.equal(s.length, 1);
    assert.equal(s[0].kind, 'crafting_table');
});

test('ingest: failed gather at a known deposit marks it depleted', () => {
    const model = new WorldModel();
    model.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: { x: 5, y: 64, z: 0 }, confidence: 0.6 });
    const step = new PlanStep({
        title: 'Mine more iron', instruction: 'mine',
        expected: { kind: 'inventory', item: 'iron_ore', gained: 1 },
    });
    const after = capture({}, { x: 5, y: 64, z: 0 });
    ingestVerifiedStep(model, {
        step, before: capture({}, { x: 4, y: 64, z: 0 }), after,
        critique: { outcome: OUTCOME.FAILED, reasoning: 'no iron left' },
    });
    const hit = model.nearest(CATEGORY.RESOURCE, after.position, { name: 'iron_ore' });
    assert.equal(hit.fact.detail.depleted, true);
    assert.ok(hit.fact.confidence <= 0.2);
});

// ---------- live event collector ----------

function fakeVec3(x = 0, y = 64, z = 0) {
    const v = { x, y, z };
    v.distanceTo = (o) => Math.hypot(o.x - v.x, o.y - v.y, o.z - v.z);
    return v;
}

function fakeBot(entities = {}) {
    const bot = new EventEmitter();
    bot.health = 20;
    bot.food = 18;
    bot.game = { dimension: 'overworld' };
    bot.entity = { id: 1, position: fakeVec3() };
    bot.entities = { [bot.entity.id]: bot.entity, ...entities };
    return bot;
}

function mobEntity(id, name, x, y = 64, z = 0, type = 'mob', extra = {}) {
    return { id, name, type, displayName: name, position: fakeVec3(x, y, z), ...extra };
}

test('collector: entity spawns/ticks become facts with TTLs and death saves a location', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-col-'));
    try {
        const agent = { name: 'colbot', bot: null };
        const model = new WorldModel();
        const store = new WorldModelStore('colbot', dir);
        const bot = fakeBot({
            2: mobEntity(2, 'cow', 5),
            3: mobEntity(3, 'item', 2, 64, 0, 'object', {
                metadata: { 8: { name: 'iron_ingot', count: 2 } },
            }),
        });
        agent.bot = bot;
        const collector = new ObservationCollector(agent, model, { store });
        collector.attach(bot);

        bot.emit('entitySpawn', mobEntity(9, 'zombie', 4));
        assert.equal(model.all(CATEGORY.THREAT).length, 1);
        assert.equal(model.all(CATEGORY.THREAT)[0].name, 'zombie');

        collector.scanEntities();
        assert.ok(model.all(CATEGORY.ENTITY).some((f) => f.name === 'cow'));
        assert.ok(model.all(CATEGORY.RESOURCE).some((f) => f.name === 'iron_ingot'));

        collector.refreshPlayer();
        assert.equal(model.player.health, 20);
        assert.deepEqual(model.player.position, { x: 0, y: 64, z: 0 });

        // dropped items expire fast
        model.tick(Date.now() + 31_000);
        assert.ok(!model.all(CATEGORY.RESOURCE).some((f) => f.kind === 'ground_item'));

        // death records the spot and clears threats
        bot.entity.position = fakeVec3(77, 40, -12);
        bot.emit('death');
        const death = model.lastSeen('last_death_position', [CATEGORY.LOCATION]);
        assert.ok(death);
        assert.equal(death.pos.x, 77);
        assert.equal(model.all(CATEGORY.THREAT).length, 0);
        assert.equal(model.player.health, 0);

        collector.saveNow();
        const disk = store.load();
        assert.ok(disk.lastSeen('last_death_position', [CATEGORY.LOCATION]));
        collector.detach();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('collector: respawn invalidates stale threats; hurt attributes the attacker', () => {
    const agent = { name: 'colbot2' };
    const model = new WorldModel();
    const bot = fakeBot();
    agent.bot = bot;
    const collector = new ObservationCollector(agent, model, { store: null });
    collector.attach(bot);

    bot.emit('entitySpawn', mobEntity(9, 'creeper', 3));
    assert.equal(model.all(CATEGORY.THREAT).length, 1);
    bot.emit('spawn'); // initial spawn
    assert.equal(model.all(CATEGORY.THREAT).length, 1, 'initial spawn keeps facts');
    bot.emit('spawn'); // respawn after death
    assert.equal(model.all(CATEGORY.THREAT).length, 0, 'respawn clears threats');

    const zombie = mobEntity(10, 'zombie', 2);
    bot.entities[10] = zombie;
    bot.emit('entityHurt', bot.entity);
    assert.ok(model.all(CATEGORY.THREAT).some((f) => f.detail.attackedBot));
});

test('planner prompts include known world facts and the expected_delta contract', async () => {
    const model = new WorldModel();
    model.record(CATEGORY.LOCATION, { name: 'village', kind: 'village', pos: { x: 300, y: 64, z: 300 }, confidence: 0.6 });
    let capturedUser = '';
    let capturedSystem = '';
    const planner = new Planner({ prompter: {}, bot: {}, world_model: model }, {
        sendRequest: async (messages, system) => {
            capturedUser = messages[0].content;
            capturedSystem = system;
            return JSON.stringify({
                summary: 's',
                steps: [{
                    title: 'Craft hopper', instruction: 'craft',
                    expected: { kind: 'inventory', item: 'hopper', gained: 1 },
                    expected_delta: { 'inventory.hopper': 1, 'inventory.iron_ingot': -5 },
                }],
            });
        },
    });
    const { project } = await planner.createPlan('automate iron');
    assert.match(capturedUser, /KNOWN WORLD FACTS/);
    assert.match(capturedUser, /village/);
    assert.match(capturedSystem, /expected_delta/);
    assert.equal(project.steps[0].expectedDelta.length, 2);
});

// ---------- end-to-end via the runner ----------

function fakeAgent(model) {
    const chats = [];
    return {
        name: 'testbot',
        world_model: model,
        observation_collector: null,
        openChat: (m) => chats.push(m),
        chats,
        shut_up: false,
        history: { add: () => {}, save: async () => {} },
        actions: { stop: async () => {} },
        self_prompter: { isActive: () => false, stop: async () => {} },
        bot: {
            health: 20, food: 20, game: { dimension: 'overworld' }, output: '',
            entity: { position: { x: 0, y: 64, z: 0, toFixed: () => '0', floored() { return { offset: () => ({ x: 0, y: 64, z: 0 }) }; } } },
            inventory: { slots: [] },
            entities: {}, blockAt: () => ({ name: 'air' }),
        },
    };
}

test('runner: executor claims craft success but no state delta -> retry -> replan -> abort', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-delta-'));
    try {
        const { project } = (() => {
            const { steps } = stepsFromJSON([{
                title: 'Craft a hopper', instruction: 'craft one hopper',
                expected: { kind: 'freeform', description: 'hopper crafted' },
                expected_delta: { 'inventory.hopper': 1, 'inventory.iron_ingot': -5 },
            }]);
            return { project: new Project({ goal: 'hopper', steps, status: PROJECT.ACTIVE }) };
        })();
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        planner.createPlan = async () => ({ project, warnings: [] });
        planner.replan = async () => ({ impossible: true, reason: 'no iron in the world' });

        const agent = fakeAgent(new WorldModel());
        let attempts = 0;
        agent.bot.inventory.slots = [];
        agent.handleMessage = async () => { attempts += 1; return true; }; // always "succeeds"
        const runner = new PlanRunner(agent, { planner, store: new ProjectStore('testbot', dir) });
        runner.config = () => ({
            max_step_attempts: 2, max_replans: 3, max_executions: 60,
            executor_max_responses: 6, step_cooldown_ms: 0, freeform_critic: false, autoresume: false,
        });
        await runner.start('hopper');
        await runner.waitForCompletion();
        assert.equal(attempts, 2, 'retried once after unverified claim');
        assert.equal(project.status, PROJECT.FAILED);
        assert.ok(agent.chats.some((c) => c.includes('state transition') || c.includes("didn't verify")));
        assert.ok(!agent.world_model.hasRecipe('hopper'), 'no recipe learned from a fake success');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runner: failed gather retries, succeeds on second attempt, resource fact persisted, project clears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-delta2-'));
    try {
        const { steps } = stepsFromJSON([{
            title: 'Mine oak logs', instruction: 'chop oak trees',
            expected: { kind: 'inventory', item: 'oak_log', gained: 2 },
            expected_delta: { 'inventory.oak_log': 2 },
        }]);
        const project = new Project({ goal: 'logs', steps, status: PROJECT.ACTIVE });
        const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: null });
        planner.createPlan = async () => ({ project, warnings: [] });
        const agent = fakeAgent(new WorldModel());
        let attempts = 0;
        agent.handleMessage = async () => {
            attempts += 1;
            if (attempts >= 2) agent.bot.inventory.slots = [{ name: 'oak_log', count: 3 }];
            return true;
        };
        const store = new ProjectStore('testbot', dir);
        const runner = new PlanRunner(agent, { planner, store });
        runner.config = () => ({
            max_step_attempts: 2, max_replans: 3, max_executions: 60,
            executor_max_responses: 6, step_cooldown_ms: 0, freeform_critic: false, autoresume: false,
        });
        await runner.start('logs');
        await runner.waitForCompletion();
        assert.equal(project.status, PROJECT.DONE);
        const hit = agent.world_model.queryNearest('oak_log', { x: 0, y: 64, z: 0 });
        assert.ok(hit, 'verified gather recorded a deposit');
        assert.equal(store.load(), null, 'completed project cleared');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
