import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setHome, getHome } from '../src/agent/navigation/home.js';
import { WorldModel, CATEGORY } from '../src/agent/world_model/world_model.js';
import { MemoryBank } from '../src/agent/memory_bank.js';

function mockAgent({ withWorldModel = true, withMemoryBank = true } = {}) {
    return {
        bot: { entity: { position: { x: 12.6, y: 64.0, z: -8.2 } } },
        world_model: withWorldModel ? new WorldModel() : null,
        memory_bank: withMemoryBank ? new MemoryBank() : null,
    };
}

test('setHome records the current position and getHome recalls it', () => {
    const agent = mockAgent();
    const pos = setHome(agent);
    assert.deepEqual(pos, { x: 12.6, y: 64, z: -8.2 });

    const home = getHome(agent);
    assert.deepEqual(home, { x: 13, y: 64, z: -8 }, 'world model stores rounded ints');
});

test('setHome updates in place instead of duplicating facts', () => {
    const agent = mockAgent();
    setHome(agent);
    agent.bot.entity.position = { x: 100, y: 70, z: 100 };
    setHome(agent);

    const homeFacts = agent.world_model.facts[CATEGORY.LOCATION].filter((f) => f.key === 'home');
    assert.equal(homeFacts.length, 1, 'home must merge under a stable key');
    assert.deepEqual(homeFacts[0].pos, { x: 100, y: 70, z: 100 });
});

test('home survives through world-model JSON persistence', () => {
    const agent = mockAgent();
    setHome(agent);
    const restored = WorldModel.fromJSON(agent.world_model.toJSON());
    const fact = restored.facts[CATEGORY.LOCATION].find((f) => f.key === 'home');
    assert.ok(fact, 'home fact persists through JSON round-trip');
    assert.deepEqual(fact.pos, { x: 13, y: 64, z: -8 });
});

test('getHome falls back to the memory bank when the world model has no home', () => {
    const agent = mockAgent({ withWorldModel: false });
    agent.memory_bank.rememberPlace('home', 1, 2, 3);
    assert.deepEqual(getHome(agent), { x: 1, y: 2, z: 3 });
});

test('getHome returns null when nothing is set', () => {
    assert.equal(getHome(mockAgent()), null);
    assert.equal(getHome(null), null);
});

test('setHome without a position is a no-op', () => {
    const agent = { bot: {}, world_model: new WorldModel(), memory_bank: new MemoryBank() };
    assert.equal(setHome(agent), null);
    assert.equal(getHome(agent), null);
});

test('setHome degrades gracefully with no persistence layers at all', () => {
    const agent = { bot: { entity: { position: { x: 5, y: 64, z: 5 } } } };
    const pos = setHome(agent);
    assert.deepEqual(pos, { x: 5, y: 64, z: 5 });
    // Nothing to recall from, but nothing throws.
    assert.equal(getHome(agent), null);
});
