import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/agent/execution/index.js';
import { DangerMonitor } from '../src/agent/execution/danger_monitor.js';

function botWithZombie() {
    const bot = {
        health: 5,
        air: 300,
        entity: { position: { x: 0, y: 64, z: 0 } },
        entities: { zombie: { name: 'zombie', type: 'mob', position: { x: 3, y: 64, z: 0 } } },
        blockAt(pos) {
            if (pos.y < 63) return { name: 'stone' };
            return { name: 'air' };
        },
    };
    return bot;
}

test('DangerMonitor emits deterministic low-health and hostile events once', async () => {
    const bus = new EventBus();
    const events = [];
    bus.on('*', event => events.push(event));
    const monitor = new DangerMonitor({ bot: botWithZombie(), eventBus: bus, hazardRadius: 2 });
    await monitor.tick();
    await monitor.tick();
    assert.ok(events.some(event => event.type === 'danger.detected' && event.data.reason === 'low_health'));
    assert.ok(events.some(event => event.type === 'danger.detected' && event.data.reason === 'hostile_entity'));
    assert.equal(events.filter(event => event.type === 'danger.detected').length, 2);
});

test('DangerMonitor emits danger.cleared when a threat disappears', async () => {
    const bus = new EventBus();
    const events = [];
    bus.on('*', event => events.push(event));
    const bot = botWithZombie();
    const monitor = new DangerMonitor({ bot, eventBus: bus, healthThreshold: 0, hazardRadius: 2 });
    await monitor.tick();
    bot.entities = {};
    await monitor.tick();
    assert.ok(events.some(event => event.type === 'danger.cleared' && event.data.reason === 'hostile_entity'));
});
