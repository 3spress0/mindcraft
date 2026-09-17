import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import { resolvePatrolStops, executePatrol, executePatrolNeed } from '../src/agent/autonomy/patrol.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';
import { RETURN_HOME_KINDS } from '../src/agent/autonomy/task_loop.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function patrolAgent(botName = 'PatrolBot', over = {}) {
    const map = new MentalMap({ botName, dir: tmp });
    map.note({ x: 20, y: 64, z: 0 }, { name: 'north-tower', type: 'landmark' });
    map.note({ x: 0, y: 64, z: 25 }, { name: 'south-gate', type: 'landmark' });
    return {
        bot: { username: botName, entity: { position: new Vec3(0, 64, 0) } },
        _mental_map: map,
        memory_bank: { recallPlace: (k) => (k === 'home' ? [0, 64, 0] : null) },
        ...over
    };
}

describe('resolvePatrolStops', () => {
    it('resolves POI names and home', () => {
        const agent = patrolAgent('ResolveBot');
        const { stops, missing } = resolvePatrolStops(agent, ['north-tower', 'home', 'south-gate']);
        assert.equal(missing.length, 0);
        assert.deepEqual(stops.map(s => s.name), ['north-tower', 'home', 'south-gate']);
        assert.equal(stops[1].x, 0);
    });

    it('reports missing stops', () => {
        const agent = patrolAgent('MissingBot');
        const { stops, missing } = resolvePatrolStops(agent, ['north-tower', 'nowhere']);
        assert.equal(stops.length, 1);
        assert.deepEqual(missing, ['nowhere']);
    });

    it('ignores blanks', () => {
        const agent = patrolAgent('BlankBot');
        const { stops } = resolvePatrolStops(agent, ['', '  ', 'north-tower']);
        assert.equal(stops.length, 1);
    });
});

describe('executePatrol', () => {
    it('requires a bot and at least two stops', async () => {
        assert.match(await executePatrol({}, {}), /no bot/);
        assert.match(await executePatrol({ bot: {} }, { stops: [] }), /at least two stops/);
        assert.match(await executePatrol({ bot: {} }, { stops: [{ name: 'a', x: 0, y: 64, z: 0 }] }), /at least two stops/);
    });

    it('executePatrolNeed reports unknown stops', async () => {
        const agent = patrolAgent('NeedUnknownBot');
        const msg = await executePatrolNeed(agent, {}, { patrol_pois: ['nowhere'] });
        assert.match(msg, /unknown stop/);
    });

    it('executePatrolNeed requires two configured stops', async () => {
        const agent = patrolAgent('NeedOneBot');
        const msg = await executePatrolNeed(agent, {}, { patrol_pois: ['north-tower'] });
        assert.match(msg, /at least two patrol_pois/);
    });
});

describe('patrol need wiring', () => {
    it('configured patrol replaces idle exploration by day', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 120000, isNight: false,
            inventoryCounts: {}, foodCount: 9, patrolReady: true
        }, {});
        assert.ok(needs.some(n => n.kind === 'patrol'));
        assert.ok(!needs.some(n => n.kind === 'explore'));
    });

    it('falls back to exploration at night even with patrol configured', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 120000, isNight: true,
            inventoryCounts: {}, foodCount: 9, patrolReady: true
        }, {});
        assert.ok(needs.some(n => n.kind === 'explore'));
        assert.ok(!needs.some(n => n.kind === 'patrol'));
    });

    it('no patrol without enough configured stops', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 120000, isNight: false,
            inventoryCounts: {}, foodCount: 9, patrolReady: false
        }, {});
        assert.ok(!needs.some(n => n.kind === 'patrol'));
        assert.ok(needs.some(n => n.kind === 'explore'));
    });

    it('return-home covers the wandering errands', () => {
        for (const k of ['explore', 'farm', 'inventory_full', 'patrol']) {
            assert.ok(RETURN_HOME_KINDS.has(k), `${k} should return home`);
        }
        assert.ok(!RETURN_HOME_KINDS.has('rest'));
        assert.ok(!RETURN_HOME_KINDS.has('maintain_base'));
    });
});

describe('!patrol command', () => {
    it('validates stop names before walking', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!patrol');
        const agent = patrolAgent('PatrolCmdBot');
        agent.actions = { runAction: async (label, fn) => { await fn(); return { interrupted: false }; } };
        const msg = await cmd.perform(agent, 'north-tower nowhere');
        assert.match(msg, /Unknown patrol stop\(s\): nowhere/);
        const tooFew = await cmd.perform(agent, 'north-tower');
        assert.match(tooFew, /at least two stops/);
    });
});
