/**
 * outposts.test.js — multi-base / outpost management (GO list). Named
 * outposts live alongside home, are readable by the LLM (mental map), and
 * the autonomy loop returns to whichever base is nearest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    setHome, getHome, setOutpost, listOutposts, removeOutpost, nearestBase
} from '../src/agent/navigation/home.js';
import { WorldModel, CATEGORY } from '../src/agent/world_model/world_model.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';
import { AutonomyLoop } from '../src/agent/autonomy/task_loop.js';

function mockAgent({ pos = { x: 0, y: 64, z: 0 } } = {}) {
    const mental = new MentalMap({ botName: 'OutpostBenchBot' });
    return {
        bot: { entity: { position: { ...pos } } },
        world_model: new WorldModel(),
        memory_bank: new MemoryBank(),
        _mental_map: mental,
    };
}

test('setOutpost records a named outpost under a stable key', () => {
    const agent = mockAgent({ pos: { x: 100, y: 64, z: 100 } });
    const pos = setOutpost(agent, 'Mine Camp');
    assert.ok(pos, 'position recorded');
    const facts = agent.world_model.facts[CATEGORY.LOCATION].filter(f => f.key === 'outpost:mine-camp');
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0].pos, { x: 100, y: 64, z: 100 });

    // same name again = update in place, not a duplicate
    agent.bot.entity.position = { x: 120, y: 64, z: 120 };
    setOutpost(agent, 'mine-camp');
    const again = agent.world_model.facts[CATEGORY.LOCATION].filter(f => f.key === 'outpost:mine-camp');
    assert.equal(again.length, 1);
    assert.deepEqual(again[0].pos, { x: 120, y: 64, z: 120 });
});

test('setOutpost rejects empty names and missing position', () => {
    const agent = mockAgent();
    assert.equal(setOutpost(agent, '   '), null);
    agent.bot.entity = null;
    assert.equal(setOutpost(agent, 'camp'), null);
});

test('outposts are noted in the mental map as base POIs (LLM-readable)', () => {
    const agent = mockAgent({ pos: { x: 50, y: 64, z: 0 } });
    setOutpost(agent, 'watchtower');
    const pois = agent._mental_map.list({ type: 'base' });
    assert.ok(pois.some(p => p.name === 'outpost-watchtower'), 'visible to !pois / !memory');
});

test('listOutposts and removeOutpost manage the set', () => {
    const agent = mockAgent();
    setOutpost(agent, 'alpha');
    agent.bot.entity.position = { x: 10, y: 64, z: 10 };
    setOutpost(agent, 'beta');
    assert.deepEqual(listOutposts(agent).map(o => o.name).sort(), ['alpha', 'beta']);

    assert.equal(removeOutpost(agent, 'alpha'), true);
    assert.deepEqual(listOutposts(agent).map(o => o.name), ['beta']);
    assert.equal(removeOutpost(agent, 'alpha'), false, 'already removed');
});

test('outposts persist through world-model JSON', () => {
    const agent = mockAgent({ pos: { x: 5, y: 64, z: 5 } });
    setOutpost(agent, 'gamma');
    const restored = WorldModel.fromJSON(agent.world_model.toJSON());
    const fact = restored.facts[CATEGORY.LOCATION].find(f => f.key === 'outpost:gamma');
    assert.ok(fact?.pos, 'survives persistence');
});

test('nearestBase picks home or the closest outpost', () => {
    const agent = mockAgent({ pos: { x: 0, y: 64, z: 0 } });
    setHome(agent); // home at origin
    agent.bot.entity.position = { x: 500, y: 64, z: 500 };
    setOutpost(agent, 'far-camp');
    agent.bot.entity.position = { x: 90, y: 64, z: 0 };
    setOutpost(agent, 'near-camp');

    // standing at origin -> home is nearest
    agent.bot.entity.position = { x: 0, y: 64, z: 0 };
    assert.equal(nearestBase(agent).name, 'home');

    // standing far out -> near-camp (90) beats home (0? distance 90) and far-camp
    agent.bot.entity.position = { x: 95, y: 64, z: 0 };
    const best = nearestBase(agent);
    assert.equal(best.name, 'near-camp');
    assert.equal(best.x, 90);

    // no position available -> first candidate (home)
    agent.bot.entity = null;
    assert.equal(nearestBase(agent).name, 'home');

    // no bases at all
    const empty = mockAgent();
    assert.equal(nearestBase(empty), null);
});

test('outposts work through the memory-bank fallback path too', () => {
    const agent = {
        bot: { entity: { position: { x: 1, y: 64, z: 1 } } },
        world_model: null, // only memory bank available
        memory_bank: new MemoryBank(),
    };
    setOutpost(agent, 'delta');
    const list = listOutposts(agent);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'delta');
    assert.deepEqual(nearestBase(agent), { x: 1, y: 64, z: 1, name: 'delta' });
    removeOutpost(agent, 'delta');
    assert.equal(listOutposts(agent).length, 0);
});

test('autonomy return-home walks to the nearest base, not necessarily home', async () => {
    const agent = mockAgent({ pos: { x: 0, y: 64, z: 0 } });
    setHome(agent); // home at origin
    agent.bot.entity.position = { x: 300, y: 64, z: 300 };
    setOutpost(agent, 'field-camp');

    // now the bot is standing right next to the outpost
    agent.bot.entity.position = { x: 301, y: 64, z: 301 };
    const teleports = [];
    agent.bot.time = { timeOfDay: 6000 };
    agent.bot.entities = {};
    agent.bot.inventory = { slots: new Array(46).fill(null) };
    agent.bot.modes = { isOn: (m) => m === 'cheat' }; // goToPosition teleports
    agent.bot.chat = (msg) => teleports.push(msg);
    agent.isIdle = () => true;
    agent.isHandlingMessage = () => false;
    agent.idleForMs = () => 120000;
    agent.actions = { runAction: async (label, fn) => { await fn(); return { interrupted: false }; } };

    const loop = new AutonomyLoop(agent, {
        now: () => Date.now(),
        executors: { explore: async () => 'explored the frontier' }
    });
    loop._nextRunAt = 0;
    await loop.tick();

    assert.equal(loop.lastRun?.kind, 'explore');
    assert.match(loop.lastRun.result, /\[returned home\]/);
    assert.ok(teleports.some(t => t.includes('300 64 300')), 'teleported to the outpost, not home');
    assert.ok(!teleports.some(t => t.endsWith('0 64 0')), 'did not drag the bot all the way back to home');
});

test('!outposts command lists home and outposts', async () => {
    const { commandList } = await import('../src/agent/commands/index.js');
    const cmd = commandList.find(c => c.name === '!outposts');
    const agent = mockAgent({ pos: { x: 0, y: 64, z: 0 } });
    assert.match(cmd.perform(agent), /No bases set yet/);
    setHome(agent);
    setOutpost(agent, 'mine-camp');
    const out = cmd.perform(agent);
    assert.match(out, /home \(0, 64, 0\)/);
    assert.match(out, /outpost "mine-camp" \(0, 64, 0\)/);
});
