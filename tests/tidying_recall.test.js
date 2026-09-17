import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import { categorize, analyzeContents, planTidy, CHEST_CAPACITY } from '../src/agent/storage/tidying.js';
import { recall, buildCorpus, tokenize, scoreDoc } from '../src/agent/memory/recall.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidyrecall-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('tidying analysis', () => {
    it('fillRatio reflects distinct stacks vs capacity', () => {
        const items = Array.from({ length: 9 }, (_, i) => ({ name: `item_${i}`, count: 1 }));
        const a = analyzeContents(items);
        assert.equal(a.distinct, 9);
        assert.equal(a.fillRatio, Math.round((9 / CHEST_CAPACITY) * 100) / 100);
    });

    it('full 64-stacks are not scattered', () => {
        const a = analyzeContents([{ name: 'dirt', count: 64 }, { name: 'dirt', count: 64 }]);
        assert.equal(a.scattered.length, 0);
    });

    it('empty input is safe', () => {
        assert.deepEqual(planTidy([]), []);
        assert.equal(analyzeContents(null).distinct, 0);
        assert.deepEqual(categorize(''), 'misc');
    });

    it('scattered list is ordered by slot waste', () => {
        const items = [
            { name: 'cobblestone', count: 1 }, { name: 'cobblestone', count: 1 }, { name: 'cobblestone', count: 1 }, { name: 'cobblestone', count: 1 },
            { name: 'dirt', count: 33 }, { name: 'dirt', count: 33 }
        ];
        const { scattered } = analyzeContents(items);
        assert.equal(scattered[0].name, 'cobblestone'); // 4 stacks -> 1 (worst waste)
    });
});

describe('spatial recall engine', () => {
    it('tokenize lowercases and filters tiny tokens', () => {
        assert.deepEqual(tokenize('A bb CCC!'), ['bb', 'ccc']);
        assert.deepEqual(tokenize(''), []);
    });

    it('scoreDoc rewards exact names above substrings above notes', () => {
        const exact = { kind: 'poi', name: 'base', text: 'base my base' };
        const sub = { kind: 'poi', name: 'my-base-camp', text: 'my-base-camp' };
        const note = { kind: 'poi', name: 'spot', text: 'spot near the base hill' };
        const t = ['base'];
        assert.ok(scoreDoc(exact, t) > scoreDoc(sub, t));
        assert.ok(scoreDoc(sub, t) > scoreDoc(note, t));
        assert.equal(scoreDoc({ kind: 'poi', name: 'x', text: 'x' }, t), 0);
    });

    it('buildCorpus merges map, memory bank, and storage spots', () => {
        const map = new MentalMap({ botName: 'CorpusBot', dir: tmp });
        map.note({ x: 1, y: 64, z: 1 }, { name: 'alpha-village', type: 'village' });
        const agent = {
            bot: { username: 'CorpusBot', entity: { position: new Vec3(0, 64, 0) } },
            _mental_map: map,
            memory_bank: { memory: { home: [5, 64, 5] } },
            _storage_spots: { list: () => [{ name: 'tools', x: 7, y: 64, z: 7 }] }
        };
        const corpus = buildCorpus(agent);
        const kinds = new Set(corpus.map(d => d.kind));
        assert.ok(kinds.has('poi'));
        assert.ok(kinds.has('memory'));
        assert.ok(kinds.has('storage'));
    });

    it('recall handles empty queries and unknown terms', () => {
        const agent = { bot: { username: 'EmptyRecallBot', entity: { position: new Vec3(0, 64, 0) } } };
        assert.deepEqual(recall(agent, ''), []);
        assert.deepEqual(recall(agent, '!!'), []);
        assert.deepEqual(recall(agent, 'zzz_unknown'), []);
    });
});

describe('tidying + recall commands', () => {
    it('!organizeChest reports when no chest is near', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!organizeChest');
        const agent = {
            bot: { findBlocks: () => [], blockAt: () => null, entity: { position: new Vec3(0, 64, 0) } },
            actions: { runAction: async () => ({ interrupted: false }) }
        };
        const msg = await cmd.perform(agent);
        assert.match(msg, /No chest within 16 blocks/);
    });

    it('!findBed reports when no bed is near', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!findBed');
        const agent = {
            bot: { username: 'FindBedCmdBot', findBlocks: () => [], blockAt: () => null, entity: { position: new Vec3(0, 64, 0) } },
            _mental_map: new MentalMap({ botName: 'FindBedCmdBot', dir: tmp })
        };
        const msg = await cmd.perform(agent);
        assert.match(msg, /No bed found/);
    });

    it('!recall searches the mental map', async () => {
        const { commandList } = await import('../src/agent/commands/index.js');
        const cmd = commandList.find(c => c.name === '!recall');
        const map = new MentalMap({ botName: 'RecallCmdBot', dir: tmp });
        map.note({ x: 30, y: 64, z: 30 }, { name: 'pine-village', type: 'village', notes: 'has a library' });
        const agent = {
            bot: { username: 'RecallCmdBot', entity: { position: new Vec3(0, 64, 0) } },
            _mental_map: map
        };
        const out = cmd.perform(agent, 'village');
        assert.match(out, /RECALL "village"/);
        assert.match(out, /pine-village/);
        assert.match(cmd.perform(agent, 'nothing-here'), /don't remember/);
    });
});
