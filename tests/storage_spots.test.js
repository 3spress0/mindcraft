import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import { StorageSpotRegistry, getSpotRegistry, MAX_SPOTS } from '../src/agent/storage/placement.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spots-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function registry(botName = 'SpotBot') {
    return new StorageSpotRegistry({ botName, dir: tmp });
}

describe('StorageSpotRegistry basics', () => {
    it('adds and retrieves a named spot', () => {
        const reg = registry('AddBot');
        const spot = reg.add('tools', { x: 10.7, y: 64.2, z: -5.4 });
        assert.ok(spot);
        assert.equal(spot.name, 'tools');
        assert.equal(spot.x, 10);
        assert.equal(spot.y, 64);
        assert.equal(spot.z, -6);
        assert.equal(reg.get('tools').x, 10);
    });

    it('rejects empty or junk names', () => {
        const reg = registry('JunkBot');
        assert.equal(reg.add('', { x: 0, y: 0, z: 0 }), null);
        assert.equal(reg.add('   ', { x: 0, y: 0, z: 0 }), null);
        assert.equal(reg.add('###', { x: 0, y: 0, z: 0 }), null);
        assert.equal(reg.add(null, { x: 0, y: 0, z: 0 }), null);
    });

    it('sanitizes names but keeps readable characters', () => {
        const reg = registry('SanitizeBot');
        const spot = reg.add('my-tools 2!', { x: 1, y: 2, z: 3 });
        assert.equal(spot.name, 'my-tools 2');
    });

    it('overwrites a spot with the same name', () => {
        const reg = registry('OverwriteBot');
        reg.add('base', { x: 1, y: 1, z: 1 });
        reg.add('base', { x: 9, y: 9, z: 9 });
        assert.equal(reg.list().length, 1);
        assert.equal(reg.get('base').x, 9);
    });

    it('removes a spot', () => {
        const reg = registry('RemoveBot');
        reg.add('temp', { x: 1, y: 1, z: 1 });
        assert.equal(reg.remove('temp'), true);
        assert.equal(reg.get('temp'), null);
        assert.equal(reg.remove('temp'), false);
    });
});

describe('internal spots and listings', () => {
    it('hides internal underscore names from list() by default', () => {
        const reg = registry('InternalBot');
        reg.add('tools', { x: 1, y: 1, z: 1 });
        reg.add('_last_unload', { x: 5, y: 1, z: 1 });
        assert.equal(reg.list().length, 1);
        assert.equal(reg.list({ includeInternal: true }).length, 2);
    });

    it('nearestTo can still use internal spots', () => {
        const reg = registry('NearestInternalBot');
        reg.add('_last_unload', { x: 3, y: 64, z: 0 });
        const hit = reg.nearestTo({ x: 0, y: 64, z: 0 }, { maxDist: 64 });
        assert.equal(hit.name, '_last_unload');
        assert.equal(hit.distance, 3);
    });
});

describe('nearestTo', () => {
    it('returns the closest spot with distance', () => {
        const reg = registry('NearBot');
        reg.add('far', { x: 40, y: 64, z: 0 });
        reg.add('near', { x: 4, y: 64, z: 3 });
        const hit = reg.nearestTo({ x: 0, y: 64, z: 0 }, { maxDist: 64 });
        assert.equal(hit.name, 'near');
        assert.equal(hit.distance, 5);
    });

    it('respects maxDist', () => {
        const reg = registry('FarBot');
        reg.add('far', { x: 200, y: 64, z: 0 });
        assert.equal(reg.nearestTo({ x: 0, y: 64, z: 0 }, { maxDist: 64 }), null);
    });

    it('returns null with no position', () => {
        const reg = registry('NoPosBot');
        reg.add('a', { x: 1, y: 1, z: 1 });
        assert.equal(reg.nearestTo(null), null);
    });
});

describe('persistence', () => {
    it('saves and reloads spots', () => {
        const reg = registry('PersistBot');
        reg.add('tools', { x: 7, y: 65, z: -3 });
        reg.add('_last_unload', { x: 1, y: 1, z: 1 });
        assert.ok(reg.persist());

        const reloaded = new StorageSpotRegistry({ botName: 'PersistBot', dir: tmp });
        assert.equal(reloaded.get('tools').x, 7);
        assert.ok(reloaded.get('_last_unload'));
    });

    it('tolerates a corrupt file', () => {
        const fp = path.join(tmp, 'CorruptBot', 'storage_spots.json');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, '{not json');
        const reg = new StorageSpotRegistry({ botName: 'CorruptBot', dir: tmp });
        assert.equal(reg.list().length, 0); // loads empty, doesn't throw
    });

    it('caps the number of spots', () => {
        const reg = registry('CapBot');
        for (let i = 0; i < MAX_SPOTS + 20; i++) {
            reg.add(`spot${i}`, { x: i, y: 1, z: 1 });
        }
        assert.ok(reg.list({ includeInternal: true }).length <= MAX_SPOTS);
    });
});

describe('getSpotRegistry helper', () => {
    it('caches per bot name', () => {
        const agent = { name: 'CacheBot', bot: {} };
        const a = getSpotRegistry(agent);
        const b = getSpotRegistry(agent);
        assert.equal(a, b);
        assert.ok(a instanceof StorageSpotRegistry);
    });

    it('returns null without a bot name', () => {
        assert.equal(getSpotRegistry({}), null);
    });
});

describe('storage spot commands', () => {
    function chestBot(chestPos) {
        const chestBlock = { name: 'chest', position: chestPos };
        return {
            username: 'CmdBot',
            entity: { position: new Vec3(0, 64, 0) },
            findBlocks: () => [chestPos],
            blockAt: () => chestBlock
        };
    }

    it('!nameStorage names the nearest chest', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!nameStorage');
        const chestPos = new Vec3(3, 64, 2);
        const agent = { bot: chestBot(chestPos) };
        // inject a registry rooted in the temp dir
        agent._storage_spots = new StorageSpotRegistry({ botName: 'CmdBot', dir: tmp });
        const msg = await cmd.perform(agent, 'tools');
        assert.match(msg, /Named storage spot "tools"/);
        assert.equal(agent._storage_spots.get('tools').x, 3);
    });

    it('!nameStorage reports when no chest is near', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!nameStorage');
        const agent = { bot: { username: 'EmptyBot', entity: { position: new Vec3(0, 64, 0) }, findBlocks: () => [], blockAt: () => null } };
        agent._storage_spots = new StorageSpotRegistry({ botName: 'EmptyBot', dir: tmp });
        const msg = await cmd.perform(agent, 'tools');
        assert.match(msg, /No chest within 16 blocks/);
    });

    it('!storageSpots lists named spots', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!storageSpots');
        const agent = { bot: { username: 'ListBot' } };
        agent._storage_spots = new StorageSpotRegistry({ botName: 'ListBot', dir: tmp });
        agent._storage_spots.add('tools', { x: 1, y: 2, z: 3 });
        const out = cmd.perform(agent);
        assert.match(out, /STORAGE SPOTS/);
        assert.match(out, /tools/);
    });

    it('!storageSpots explains when empty', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!storageSpots');
        const agent = { bot: { username: 'EmptyListBot' } };
        agent._storage_spots = new StorageSpotRegistry({ botName: 'EmptyListBot', dir: tmp });
        const out = cmd.perform(agent);
        assert.match(out, /No named storage spots/);
    });
});
