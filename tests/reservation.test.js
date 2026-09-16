import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import { StorageSpotRegistry } from '../src/agent/storage/placement.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reserve-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function registry(name = 'ReserveBot') {
    return new StorageSpotRegistry({ botName: name, dir: tmp });
}

describe('storage reservations', () => {
    it('reserves an existing spot for item types', () => {
        const reg = registry('ResA');
        reg.add('tools', { x: 1, y: 2, z: 3 });
        const spot = reg.reserve('tools', ['Iron_Ingot', 'gold_ingot']);
        assert.deepEqual(spot.accepts, ['iron_ingot', 'gold_ingot']);
        assert.equal(reg.reservationFor('iron_ingot').name, 'tools');
        assert.equal(reg.reservationFor('dirt'), null);
    });

    it('returns null for unknown spots', () => {
        const reg = registry('ResB');
        assert.equal(reg.reserve('missing', ['dirt']), null);
    });

    it('clears a reservation with an empty list', () => {
        const reg = registry('ResC');
        reg.add('misc', { x: 1, y: 1, z: 1 });
        reg.reserve('misc', ['dirt']);
        const cleared = reg.reserve('misc', []);
        assert.equal(cleared.accepts, null);
        assert.equal(reg.reservationFor('dirt'), null);
    });

    it('deduplicates and caps item lists', () => {
        const reg = registry('ResD');
        reg.add('big', { x: 1, y: 1, z: 1 });
        const items = Array.from({ length: 40 }, (_, i) => `item_${i % 5}`);
        const spot = reg.reserve('big', items);
        assert.equal(spot.accepts.length, 5);
    });

    it('survives persistence', () => {
        const reg = registry('ResPersist');
        reg.add('food', { x: 9, y: 9, z: 9 });
        reg.reserve('food', ['bread', 'cooked_beef']);
        const reloaded = new StorageSpotRegistry({ botName: 'ResPersist', dir: tmp });
        assert.deepEqual(reloaded.get('food').accepts, ['bread', 'cooked_beef']);
        assert.equal(reloaded.reservationFor('cooked_beef').name, 'food');
    });

    it('re-adding a spot preserves its reservation', () => {
        const reg = registry('ResKeep');
        reg.add('ores', { x: 1, y: 1, z: 1 });
        reg.reserve('ores', ['iron_ore']);
        reg.add('ores', { x: 2, y: 1, z: 1 }); // re-name at new position
        assert.deepEqual(reg.get('ores').accepts, ['iron_ore']);
        assert.equal(reg.get('ores').x, 2);
    });
});

describe('reservation commands', () => {
    it('!reserveStorage reserves and clears', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!reserveStorage');
        const agent = { bot: { username: 'ResCmdBot' } };
        agent._storage_spots = new StorageSpotRegistry({ botName: 'ResCmdBot', dir: tmp });
        agent._storage_spots.add('tools', { x: 1, y: 2, z: 3 });

        let msg = await cmd.perform(agent, 'tools', 'iron_ingot, gold_ingot');
        assert.match(msg, /Reserved "tools" for: iron_ingot, gold_ingot/);

        msg = await cmd.perform(agent, 'tools', '');
        assert.match(msg, /Reservation cleared/);

        msg = await cmd.perform(agent, 'nope', 'dirt');
        assert.match(msg, /No storage spot named "nope"/);
    });

    it('!storageSpots shows reservations', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!storageSpots');
        const agent = { bot: { username: 'ResListBot' } };
        agent._storage_spots = new StorageSpotRegistry({ botName: 'ResListBot', dir: tmp });
        agent._storage_spots.add('ores', { x: 1, y: 1, z: 1 });
        agent._storage_spots.reserve('ores', ['iron_ingot']);
        const out = cmd.perform(agent);
        assert.match(out, /reserved: iron_ingot/);
    });

    it('!metrics reports survival stats', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!metrics');
        const agent = { name: 'MetricsCmdBot', bot: {} };
        agent._metrics = new (await import('../src/agent/library/metrics.js')).MetricsTracker({ botName: 'MetricsCmdBot', dir: tmp });
        agent._metrics.recordDeath({ cause: 'fell' });
        const out = cmd.perform(agent);
        assert.match(out, /Deaths \(all time\): 1/);
        assert.match(out, /fell/);
    });
});
