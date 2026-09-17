import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    StorageIndex,
    StorageIndexStore,
    containerKey,
    getStorageIndex,
    saveStorageIndex,
} from '../src/agent/storage/index.js';

const NOW = 1_700_000_000_000;

test('record stores container contents by position', () => {
    const index = new StorageIndex();
    const entry = index.record('chest', { x: 10, y: 64, z: -3 }, [
        { name: 'iron_ingot', count: 12 },
        { name: 'iron_ingot', count: 5 },
        { name: 'bread', count: 3 },
    ], NOW);
    assert.equal(entry.key, '10,64,-3');
    assert.equal(entry.items.iron_ingot, 17, 'stacks of the same item merge');
    assert.equal(entry.items.bread, 3);
});

test('adjust applies deposit and withdrawal deltas', () => {
    const index = new StorageIndex();
    index.record('chest', { x: 0, y: 64, z: 0 }, [{ name: 'oak_planks', count: 64 }], NOW);

    index.adjust({ x: 0, y: 64, z: 0 }, 'oak_planks', -20, { now: NOW + 1 });
    assert.equal(index.findItem('oak_planks', NOW + 1)[0].count, 44);

    index.adjust({ x: 0, y: 64, z: 0 }, 'iron_ingot', 8, { now: NOW + 2 });
    assert.equal(index.findItem('iron_ingot', NOW + 2)[0].count, 8);

    // Withdrawing past zero removes the item instead of going negative.
    index.adjust({ x: 0, y: 64, z: 0 }, 'oak_planks', -100, { now: NOW + 3 });
    assert.equal(index.findItem('oak_planks', NOW + 3).length, 0);
});

test('adjust on an unknown container creates a sparse entry', () => {
    const index = new StorageIndex();
    const entry = index.adjust({ x: 5, y: 70, z: 5 }, 'diamond', 2, { type: 'barrel', now: NOW });
    assert.equal(entry.type, 'barrel');
    assert.equal(entry.items.diamond, 2);
});

test('findItem reports every container holding an item, sorted by count', () => {
    const index = new StorageIndex();
    index.record('chest', { x: 0, y: 64, z: 0 }, [{ name: 'coal', count: 5 }], NOW);
    index.record('barrel', { x: 9, y: 64, z: 9 }, [{ name: 'coal', count: 40 }], NOW);
    index.record('chest', { x: 3, y: 64, z: 3 }, [{ name: 'iron_ingot', count: 2 }], NOW);

    const hits = index.findItem('coal', NOW);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].type, 'barrel', 'largest count first');
    assert.equal(hits[0].count, 40);
    assert.deepEqual(index.findItem('diamond', NOW), []);
});

test('totals aggregate across containers', () => {
    const index = new StorageIndex();
    index.record('chest', { x: 0, y: 64, z: 0 }, [{ name: 'coal', count: 5 }], NOW);
    index.record('chest', { x: 1, y: 64, z: 0 }, [{ name: 'coal', count: 7 }, { name: 'torch', count: 4 }], NOW);
    assert.deepEqual(index.totals(NOW), { coal: 12, torch: 4 });
});

test('notePosition registers radar-found containers without contents', () => {
    const index = new StorageIndex();
    index.notePosition('chest', { x: 4, y: 64, z: 4 }, NOW);
    assert.equal(index.containers.size, 1);
    assert.deepEqual(index.containers.get('4,64,4').items, {});
    // Second note at the same spot does not duplicate.
    index.notePosition('chest', { x: 4, y: 64, z: 4 }, NOW + 5);
    assert.equal(index.containers.size, 1);
});

test('stale entries expire after maxAgeMs', () => {
    const index = new StorageIndex({ maxAgeMs: 1000 });
    index.record('chest', { x: 0, y: 64, z: 0 }, [{ name: 'coal', count: 5 }], NOW);
    assert.equal(index.findItem('coal', NOW).length, 1);
    assert.equal(index.findItem('coal', NOW + 2000).length, 0, 'too old to trust');
    // Pruning also drops them on the next record.
    index.record('chest', { x: 1, y: 64, z: 1 }, [], NOW + 3000);
    assert.equal(index.containers.size, 1);
});

test('the container cap drops the oldest observations', () => {
    const index = new StorageIndex({ maxContainers: 3 });
    for (let i = 0; i < 5; i++) {
        index.record('chest', { x: i, y: 64, z: 0 }, [{ name: `item_${i}`, count: 1 }], NOW + i);
    }
    assert.equal(index.containers.size, 3);
    assert.ok(!index.containers.has(containerKey({ x: 0, y: 64, z: 0 })), 'oldest dropped');
    assert.ok(index.containers.has(containerKey({ x: 4, y: 64, z: 0 })), 'newest kept');
});

test('render produces a readable report', () => {
    const index = new StorageIndex();
    index.record('chest', { x: 10, y: 64, z: -3 }, [{ name: 'iron_ingot', count: 12 }], NOW);
    const text = index.render(NOW + 30_000);
    assert.match(text, /STORAGE INDEX \(1 containers, 1 distinct items\)/);
    assert.match(text, /chest at \(10, 64, -3\), seen 30s ago: iron_ingot x12/);

    const empty = new StorageIndex().render(NOW);
    assert.match(empty, /No containers indexed yet/);
});

test('JSON round-trip preserves the index', () => {
    const index = new StorageIndex();
    index.record('chest', { x: 1, y: 64, z: 2 }, [{ name: 'gold_ingot', count: 9 }], NOW);
    const clone = StorageIndex.fromJSON(index.toJSON());
    assert.deepEqual(clone.findItem('gold_ingot', NOW), index.findItem('gold_ingot', NOW));
});

test('fromJSON tolerates malformed payloads', () => {
    assert.equal(StorageIndex.fromJSON(null).containers.size, 0);
    assert.equal(StorageIndex.fromJSON({ containers: [null, {}, { key: 'a', items: { x: 1 } }] }).containers.size, 1);
});

test('store save/load round-trips on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-index-'));
    const store = new StorageIndexStore('tester', dir);
    const index = new StorageIndex();
    index.record('chest', { x: 1, y: 64, z: 2 }, [{ name: 'redstone', count: 33 }], NOW);

    assert.equal(store.save(index), true);
    const loaded = store.load();
    assert.ok(loaded);
    assert.equal(loaded.findItem('redstone', NOW)[0].count, 33);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('store load returns null when no file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-index-'));
    const store = new StorageIndexStore('nobody', dir);
    assert.equal(store.load(), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getStorageIndex attaches a shared index to agent and bot', () => {
    const agent = { name: 'StorageIndexTestBot', bot: {} };
    try {
        const index = getStorageIndex(agent);
        assert.ok(index instanceof StorageIndex);
        assert.equal(agent.storage_index, index);
        assert.equal(agent.bot._storage_index, index, 'skills see the same index via the bot');
        assert.equal(getStorageIndex(agent), index, 'idempotent');
        index.record('chest', { x: 0, y: 64, z: 0 }, [{ name: 'coal', count: 1 }]);
        saveStorageIndex(agent); // store attached: persists to bots/<name>/
        assert.equal(getStorageIndex({ name: 'StorageIndexTestBot', bot: {} }).findItem('coal').length, 1, 'reload sees the saved index');
    } finally {
        // keep the test hermetic: remove the per-bot scratch directory
        fs.rmSync(path.join(process.cwd(), 'bots', 'StorageIndexTestBot'), { recursive: true, force: true });
    }
});
