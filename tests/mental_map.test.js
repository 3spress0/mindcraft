import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import { MentalMap, getMentalMap, POI_TYPES, MAX_POIS, noteBedIfNear, BED_TYPES } from '../src/agent/memory/mental_map.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mentalmap-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function map(name = 'MapBot') {
    return new MentalMap({ botName: name, dir: tmp });
}

describe('MentalMap basics', () => {
    it('notes a place with type and coordinates', () => {
        const m = map('NoteBot');
        const res = m.note({ x: 100.4, y: 64, z: -50.2 }, { name: 'desert-village', type: 'village', notes: 'blacksmith has loot' });
        assert.ok(res.created);
        assert.equal(res.poi.name, 'desert-village');
        assert.equal(res.poi.type, 'village');
        assert.equal(res.poi.x, 100);
        assert.equal(res.poi.z, -50);
        assert.equal(m.get('desert-village').notes, 'blacksmith has loot');
    });

    it('normalizes unknown types to custom', () => {
        const m = map('TypeBot');
        const res = m.note({ x: 1, y: 2, z: 3 }, { name: 'weird', type: 'SPACESHIP' });
        assert.equal(res.poi.type, 'custom');
    });

    it('rejects junk names and positions', () => {
        const m = map('JunkBot');
        assert.equal(m.note({ x: 1, y: 1, z: 1 }, { name: '' }), null);
        assert.equal(m.note(null, { name: 'x' }), null);
        assert.equal(m.note({}, { name: 'x' }), null);
    });

    it('merges same-type notes within the merge radius', () => {
        const m = map('MergeBot');
        m.note({ x: 100, y: 64, z: 100 }, { name: 'village-a', type: 'village' });
        const res = m.note({ x: 110, y: 64, z: 102 }, { name: 'village-a', type: 'village', notes: 'bigger than I thought' });
        assert.equal(res.created, false);
        assert.equal(res.poi.seen, 2);
        assert.equal(m.list({ type: 'village' }).length, 1);
        assert.equal(res.poi.notes, 'bigger than I thought');
    });

    it('keeps different types at the same spot separate', () => {
        const m = map('MultiBot');
        m.note({ x: 10, y: 64, z: 10 }, { name: 'farm-north', type: 'farm' });
        m.note({ x: 12, y: 64, z: 10 }, { name: 'well', type: 'water' });
        assert.equal(m.list().length, 2);
    });

    it('removes a poi', () => {
        const m = map('RemoveBot');
        m.note({ x: 1, y: 1, z: 1 }, { name: 'temp' });
        assert.equal(m.remove('temp'), true);
        assert.equal(m.get('temp'), null);
        assert.equal(m.remove('temp'), false);
    });

    it('covers the documented POI types', () => {
        for (const t of ['village', 'house', 'base', 'farm', 'storage', 'water', 'cave', 'landmark', 'death', 'player', 'bed', 'spawn', 'custom']) {
            assert.ok(POI_TYPES.includes(t), `${t} missing`);
        }
    });
});

describe('MentalMap queries', () => {
    it('nearestTo finds the closest matching poi', () => {
        const m = map('NearBot');
        m.note({ x: 10, y: 64, z: 0 }, { name: 'v-close', type: 'village' });
        m.note({ x: 200, y: 64, z: 0 }, { name: 'v-far', type: 'village' });
        m.note({ x: 11, y: 64, z: 0 }, { name: 'hut', type: 'house' });
        const hit = m.nearestTo({ x: 0, y: 64, z: 0 }, { type: 'village' });
        assert.equal(hit.name, 'v-close');
        assert.equal(hit.distance, 10);
    });

    it('nearestTo respects maxDist and null pos', () => {
        const m = map('FarBot');
        m.note({ x: 1000, y: 64, z: 0 }, { name: 'far', type: 'landmark' });
        assert.equal(m.nearestTo({ x: 0, y: 64, z: 0 }, { maxDist: 100 }), null);
        assert.equal(m.nearestTo(null), null);
    });

    it('summarize renders an LLM-friendly list', () => {
        const m = map('SumBot');
        m.note({ x: 5, y: 64, z: 5 }, { name: 'base', type: 'base', notes: 'my house' });
        const out = m.summarize();
        assert.match(out, /MENTAL MAP \(1 place remembered\)/);
        assert.match(out, /base \[base\] at \(5, 64, 5\)/);
        assert.match(out, /my house/);
    });

    it('summarize explains an empty map', () => {
        assert.match(map('EmptyBot').summarize(), /No places noted yet/);
    });
});

describe('MentalMap persistence', () => {
    it('saves and reloads', () => {
        const m1 = map('PersistMapBot');
        m1.note({ x: 7, y: 65, z: -3 }, { name: 'cave-east', type: 'cave', notes: 'iron inside' });
        const m2 = new MentalMap({ botName: 'PersistMapBot', dir: tmp });
        assert.equal(m2.get('cave-east').type, 'cave');
        assert.equal(m2.get('cave-east').notes, 'iron inside');
    });

    it('tolerates a corrupt file', () => {
        const fp = path.join(tmp, 'CorruptMapBot', 'mental_map.json');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, '{broken');
        const m = new MentalMap({ botName: 'CorruptMapBot', dir: tmp });
        assert.equal(m.list().length, 0);
    });

    it('caps the number of pois', () => {
        const m = map('CapMapBot');
        for (let i = 0; i < MAX_POIS + 20; i++) {
            m.note({ x: i * 100, y: 64, z: 0 }, { name: `spot-${i}`, type: 'custom' });
        }
        assert.ok(m.list().length <= MAX_POIS);
    });
});

describe('seedFromAgent', () => {
    it('seeds home and last-death from the memory bank', () => {
        const m = map('SeedBot');
        const agent = {
            memory_bank: {
                recallPlace: (k) => k === 'home' ? [10, 64, 10] : k === 'last_death_position' ? [-30, 60, 20] : null
            }
        };
        const added = m.seedFromAgent(agent);
        assert.ok(added >= 2);
        assert.equal(m.get('home').type, 'base');
        assert.equal(m.get('last-death').type, 'death');
        // running again adds nothing
        assert.equal(m.seedFromAgent(agent), 0);
    });

    it('seeds storage spots from the spot registry', () => {
        const m = map('SeedStorageBot');
        const agent = {
            _storage_spots: { list: () => [{ name: 'tools', x: 3, y: 64, z: 4 }] }
        };
        m.seedFromAgent(agent);
        const hit = m.nearestTo({ x: 3, y: 64, z: 4 }, { type: 'storage' });
        assert.ok(hit);
    });
});

describe('bed / respawn awareness', () => {
    it('knows all 16 bed colors', () => {
        assert.equal(BED_TYPES.length, 16);
        assert.ok(BED_TYPES.includes('red_bed'));
        assert.ok(BED_TYPES.includes('white_bed'));
    });

    it('notes the nearest bed as the respawn anchor', () => {
        const bedPos = new Vec3(4, 64, 2);
        const bedBlock = { name: 'red_bed', position: bedPos };
        const agent = {
            bot: {
                username: 'BedBot',
                entity: { position: new Vec3(0, 64, 0) },
                findBlocks: () => [bedPos],
                blockAt: () => bedBlock
            },
            _mental_map: new MentalMap({ botName: 'BedBot', dir: tmp })
        };
        const poi = noteBedIfNear(agent, { radius: 32 });
        assert.ok(poi);
        assert.equal(poi.type, 'bed');
        assert.equal(poi.x, 4);
        assert.match(poi.notes, /red_bed/);
        // scanning again merges rather than duplicates
        noteBedIfNear(agent, { radius: 32 });
        assert.equal(agent._mental_map.list({ type: 'bed' }).length, 1);
    });

    it('returns null when no bed is near', () => {
        const agent = {
            bot: {
                username: 'NoBedBot',
                entity: { position: new Vec3(0, 64, 0) },
                findBlocks: () => [],
                blockAt: () => null
            },
            _mental_map: new MentalMap({ botName: 'NoBedBot', dir: tmp })
        };
        assert.equal(noteBedIfNear(agent), null);
    });
});

describe('getMentalMap helper', () => {
    it('caches per bot name', () => {
        const agent = { name: 'CacheMapBot', bot: {} };
        assert.equal(getMentalMap(agent), getMentalMap(agent));
    });

    it('returns null without a bot name', () => {
        assert.equal(getMentalMap({}), null);
    });
});

describe('mental map commands', () => {
    function cmdAgent(botName = 'PoiCmdBot') {
        const agent = { bot: { username: botName, entity: { position: { x: 12, y: 65, z: -4 } } } };
        agent._mental_map = new MentalMap({ botName, dir: tmp });
        return agent;
    }

    it('!notePlace notes the current position', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!notePlace');
        const agent = cmdAgent('NoteCmdBot');
        const msg = await cmd.perform(agent, 'riverside-house', 'house', 'two floors, door broken');
        assert.match(msg, /Noted house "riverside-house" at \(12, 65, -4\)/);
        assert.equal(agent._mental_map.get('riverside-house').notes, 'two floors, door broken');
        // noting again merges
        const again = await cmd.perform(agent, 'riverside-house', 'house');
        assert.match(again, /Updated my note on "riverside-house"/);
    });

    it('!forgetPoi removes a place', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!forgetPoi');
        const agent = cmdAgent('ForgetCmdBot');
        agent._mental_map.note({ x: 1, y: 2, z: 3 }, { name: 'old-camp', type: 'base' });
        assert.match(await cmd.perform(agent, 'old-camp'), /Forgot "old-camp"/);
        assert.match(await cmd.perform(agent, 'old-camp'), /No place named/);
    });

    it('!pois lists and filters', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!pois');
        const agent = cmdAgent('PoisCmdBot');
        agent._mental_map.note({ x: 5, y: 64, z: 5 }, { name: 'v-west', type: 'village' });
        agent._mental_map.note({ x: 9, y: 64, z: 9 }, { name: 'my-base', type: 'base' });
        const all = cmd.perform(agent);
        assert.match(all, /MENTAL MAP \(2 places remembered\)/);
        const villages = cmd.perform(agent, 'village');
        assert.match(villages, /VILLAGE POIS \(1\)/);
        assert.match(villages, /v-west/);
        assert.match(cmd.perform(agent, 'cave'), /No cave POIs noted/);
    });

    it('!goToPoi validates before traveling', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!goToPoi');
        const agent = cmdAgent('GoCmdBot');
        const msg = await cmd.perform(agent, 'nowhere');
        assert.match(msg, /No place named "nowhere"/);
    });

    it('!memory includes the mental map', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!memory');
        const agent = cmdAgent('MemoryCmdBot');
        agent._mental_map.note({ x: 5, y: 64, z: 5 }, { name: 'v-west', type: 'village' });
        const out = cmd.perform(agent);
        assert.match(out, /MENTAL MAP/);
        assert.match(out, /v-west/);
    });

    it('!fetchItem reports when nothing is stored', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!fetchItem');
        const { StorageIndex } = await import('../src/agent/storage/index.js');
        const agent = { name: 'FetchCmdBot', bot: { username: 'FetchCmdBot' }, storage_index: new StorageIndex() };
        const msg = await cmd.perform(agent, 'diamond', 3);
        assert.match(msg, /No stored diamond on record/);
    });
});
