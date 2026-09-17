/**
 * storage_benchmark.test.js — deterministic storage benchmark (GO list:
 * storage benchmark). Drives the real unload/balancing/reservation/tidy/fetch
 * decision logic at scale and asserts behavioral properties: essentials are
 * never deposited, deposits spread instead of piling up, reservations are
 * honored under load, tidy plans are correct, and fetch coverage is honest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { isEdible, shouldKeep, itemsToUnload } from '../src/agent/autonomy/unload.js';
import { rankChests, distributeDeposits, estimatedFreeSlots, CHEST_SLOTS } from '../src/agent/storage/balancing.js';
import { StorageIndex, containerKey } from '../src/agent/storage/index.js';
import { analyzeContents, planTidy, categorize, categoryManifest } from '../src/agent/storage/tidying.js';
import { planFetch } from '../src/agent/storage/fetch.js';
import { recall, recallSummary, tokenize } from '../src/agent/memory/recall.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

function item(name, slot, count = 1) {
    return { name, slot, count, type: slot, maxDurability: null, durabilityUsed: 0 };
}

function botWith(items) {
    const slots = [];
    for (const it of items) slots[it.slot] = it;
    return { registry: null, inventory: { slots } };
}

describe('storage bench S1: bulk unload policy at scale', () => {
    it('300+ mixed items unload only non-essentials, sorted by volume', () => {
        const items = [];
        let slot = 9;
        items.push(item('cobblestone', slot++, 64), item('cobblestone', slot++, 64), item('cobblestone', slot++, 64));
        items.push(item('diorite', slot++, 64), item('diorite', slot++, 64));
        items.push(item('granite', slot++, 32));
        items.push(item('iron_pickaxe', slot++, 1));
        items.push(item('iron_sword', slot++, 1));
        items.push(item('bread', slot++, 12));
        items.push(item('water_bucket', slot++, 1));
        items.push(item('iron_chestplate', slot++, 1));
        const list = itemsToUnload(botWith(items), { maxTypes: 8 });
        assert.deepEqual(list.map(e => e.name), ['cobblestone', 'diorite', 'granite']);
        assert.equal(list[0].count, 192);
        // essentials never appear
        for (const keep of ['iron_pickaxe', 'iron_sword', 'bread', 'water_bucket', 'iron_chestplate']) {
            assert.ok(!list.some(e => e.name === keep), `${keep} must stay`);
        }
    });
});

describe('storage bench S2: deposits spread instead of piling up', () => {
    it('10 deposit rounds over 3 chests keep fill balanced', () => {
        const positions = [new Vec3(2, 64, 0), new Vec3(4, 64, 0), new Vec3(6, 64, 0)];
        const index = new StorageIndex();
        const fill = new Map(positions.map(p => [containerKey(p), 0])); // stacks placed

        for (let round = 0; round < 10; round++) {
            const chests = positions.map(p => ({ name: 'chest', position: p }));
            const ranked = rankChests(chests, { index, pos: new Vec3(0, 64, 0), maxChests: 3 });
            const entries = [{ name: `item_${round}`, count: 64 }]; // 1 stack each round
            const plan = distributeDeposits(entries, ranked);
            assert.equal(plan.size, 1, 'one stack fits one chest');
            for (const [key, target] of plan) {
                fill.set(key, (fill.get(key) ?? 0) + target.items.length);
                for (const e of target.items) index.adjust(target.pos, e.name, e.count);
            }
        }

        const counts = [...fill.values()];
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        assert.equal(counts.reduce((a, b) => a + b, 0), 10);
        assert.ok(max - min <= 1, `unbalanced spread: ${counts.join(',')} (max-min=${max - min})`);
    });

    it('a full chest stops receiving deposits', () => {
        const full = new Vec3(2, 64, 0);
        const empty = new Vec3(3, 64, 0);
        const index = new StorageIndex();
        for (let i = 0; i < CHEST_SLOTS; i++) index.adjust(full, `stack_${i}`, 64);
        const ranked = rankChests(
            [{ name: 'chest', position: full }, { name: 'chest', position: empty }],
            { index, pos: new Vec3(0, 64, 0) });
        assert.equal(containerKey(ranked[0].pos), containerKey(empty));
        assert.equal(estimatedFreeSlots(index.containers.get(containerKey(full))), 0);
    });
});

describe('storage bench S3: reservations honored under load', () => {
    it('reserved types always land in their chest even when others are nearer', () => {
        const general = { key: 'g', pos: new Vec3(1, 64, 0), free: 27, distance: 1, score: 27 };
        const reservedPos = { x: 40, y: 64, z: 40 };
        const reservations = [{ name: 'ores', x: reservedPos.x, y: reservedPos.y, z: reservedPos.z, accepts: ['iron_ingot', 'gold_ingot'] }];
        const entries = [
            { name: 'iron_ingot', count: 24 },
            { name: 'cobblestone', count: 64 },
            { name: 'gold_ingot', count: 8 }
        ];
        const plan = distributeDeposits(entries, [general], reservations);
        const resKey = containerKey(reservedPos);
        const resTarget = plan.get(resKey);
        assert.ok(resTarget);
        assert.deepEqual(resTarget.items.map(i => i.name).sort(), ['gold_ingot', 'iron_ingot']);
        const generalTarget = plan.get('g');
        assert.deepEqual(generalTarget.items.map(i => i.name), ['cobblestone']);
    });
});

describe('storage bench S4: tidy plans', () => {
    it('detects scattered stacks and plans exact consolidation', () => {
        const contents = [
            { name: 'cobblestone', count: 30 }, { name: 'cobblestone', count: 30 }, { name: 'cobblestone', count: 4 },
            { name: 'dirt', count: 64 },
            { name: 'iron_ingot', count: 10 }, { name: 'iron_ingot', count: 10 }
        ];
        const analysis = analyzeContents(contents);
        assert.equal(analysis.scattered.length, 2); // cobblestone (3->1) and iron_ingot (2->1)
        const plan = planTidy(contents);
        const cobble = plan.find(p => p.item === 'cobblestone');
        assert.equal(cobble.stacksBefore, 3);
        assert.equal(cobble.stacksAfter, 1);
        const iron = plan.find(p => p.item === 'iron_ingot');
        assert.equal(iron.stacksBefore, 2);
        assert.equal(iron.stacksAfter, 1);
    });

    it('an already-tidy chest yields an empty plan', () => {
        assert.equal(planTidy([{ name: 'dirt', count: 64 }, { name: 'stone', count: 12 }]).length, 0);
    });

    it('categories group sensibly for manifests', () => {
        assert.equal(categorize('iron_pickaxe'), 'tools');
        assert.equal(categorize('diamond_chestplate'), 'armor');
        assert.equal(categorize('cooked_beef'), 'food');
        assert.equal(categorize('iron_ingot'), 'resources');
        assert.equal(categorize('oak_planks'), 'blocks');
        const manifest = categoryManifest([
            { name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 32 }, { name: 'iron_ingot', count: 32 }
        ]);
        assert.equal(manifest[0][0], 'resources');
        assert.equal(manifest[0][1], 64);
    });
});

describe('storage bench S5: fetch coverage honesty', () => {
    it('reports exact totals across many containers', () => {
        const index = new StorageIndex();
        let expected = 0;
        for (let i = 0; i < 12; i++) {
            const n = (i % 4) * 8 + 4;
            index.record('chest', { x: i * 8, y: 64, z: 0 }, [{ name: 'iron_ingot', count: n }]);
            expected += n;
        }
        const agent = { name: 'BenchFetch', storage_index: index };
        const plan = planFetch(agent, 'iron_ingot', 40);
        assert.equal(plan.total, expected);
        assert.equal(plan.targets.length, 12);
        assert.equal(plan.covered, true);
        const planAll = planFetch(agent, 'iron_ingot', -1);
        assert.equal(planAll.want, expected);
        const planBig = planFetch(agent, 'iron_ingot', expected + 100);
        assert.equal(planBig.covered, false);
    });
});

describe('storage bench S6: spatial recall over a busy mental map', () => {
    it('ranks exact, substring, and note matches deterministically', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recallbench-'));
        try {
            const map = new MentalMap({ botName: 'RecallBench', dir: tmp });
            map.note({ x: 100, y: 64, z: 100 }, { name: 'desert-village', type: 'village', notes: 'blacksmith has loot' });
            map.note({ x: -40, y: 64, z: 20 }, { name: 'village-hill', type: 'village', notes: 'small, no iron golem' });
            map.note({ x: 10, y: 64, z: 10 }, { name: 'my-base', type: 'base', notes: 'chest room inside' });
            const agent = {
                bot: { username: 'RecallBench', entity: { position: new Vec3(0, 64, 0) } },
                _mental_map: map,
                memory_bank: { memory: { 'old-camp': [200, 60, -200] } }
            };

            const villages = await recall(agent, 'village');
            assert.equal(villages.length, 2);
            assert.ok(villages.every(h => h.name.includes('village')));
            // nearer village first on tie-break
            assert.equal(villages[0].name, 'village-hill');

            const smith = await recall(agent, 'blacksmith');
            assert.equal(smith[0].name, 'desert-village');

            const camp = await recall(agent, 'camp');
            assert.equal(camp[0].kind, 'memory');

            assert.equal((await recall(agent, 'zzzz-nothing')).length, 0);
            assert.match(recallSummary('zzzz-nothing', []), /don't remember/);
            assert.deepEqual(tokenize('Desert VILLAGE!!'), ['desert', 'village']);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
