import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sortKey, computeSortPlan, isSorted } from '../src/agent/storage/sorting.js';
import { categorize } from '../src/agent/storage/tidying.js';

function slot(name, count = 1) {
    return name ? { name, count, type: 1 } : null;
}

function applyMoves(slots, moves) {
    const working = slots.map(s => (s ? { ...s } : null));
    for (const mv of moves) {
        const tmp = working[mv.to];
        working[mv.to] = working[mv.from];
        working[mv.from] = tmp;
    }
    return working;
}

describe('sortKey', () => {
    it('orders categories tools < armor < food < resources < blocks < misc', () => {
        const order = ['iron_pickaxe', 'iron_chestplate', 'bread', 'iron_ingot', 'oak_planks', 'weird_thing'];
        const keys = order.map(n => sortKey(slot(n)));
        for (let i = 1; i < keys.length; i++) {
            assert.ok(keys[i - 1].cat < keys[i].cat, `${order[i - 1]} should sort before ${order[i]}`);
        }
    });

    it('returns null for empty slots', () => {
        assert.equal(sortKey(null), null);
        assert.equal(sortKey({}), null);
    });
});

describe('computeSortPlan', () => {
    it('sorts a shuffled chest into category/name/count order', () => {
        const shuffled = [
            slot('dirt', 32), slot('iron_pickaxe'), slot('bread', 4),
            null, slot('iron_ingot', 16), slot('dirt', 64), slot('apple')
        ];
        const { target, moves } = computeSortPlan(shuffled);
        assert.ok(moves.length > 0, 'shuffled chest needs moves');
        // target: tools first, then food by name, resources, blocks (big
        // stacks first), empties last
        const names = target.map(t => t?.name ?? null);
        assert.deepEqual(names, ['iron_pickaxe', 'apple', 'bread', 'iron_ingot', 'dirt', 'dirt', null]);
        assert.equal(target[4].count, 64); // bigger dirt stack first
        assert.equal(target[5].count, 32);
        // applying the swaps reproduces the target arrangement
        const after = applyMoves(shuffled, moves);
        assert.deepEqual(after.map(s => s?.name ?? null), names);
        assert.deepEqual(after.map(s => s?.count ?? null), target.map(t => t?.count ?? null));
    });

    it('empty chest needs no moves', () => {
        const { moves } = computeSortPlan(new Array(27).fill(null));
        assert.equal(moves.length, 0);
    });

    it('already-sorted chest needs no moves', () => {
        const sorted = [slot('bread', 3), slot('iron_ingot', 8), slot('dirt', 64), null, null];
        assert.equal(computeSortPlan(sorted).moves.length, 0);
        assert.equal(isSorted(sorted), true);
    });

    it('duplicates of the same item order by count desc', () => {
        const chest = [slot('cobblestone', 10), slot('cobblestone', 64), slot('cobblestone', 30)];
        const { target } = computeSortPlan(chest);
        assert.deepEqual(target.map(t => t.count), [64, 30, 10]);
    });

    it('survives pathological single-slot input', () => {
        assert.equal(computeSortPlan([slot('dirt')]).moves.length, 0);
        assert.equal(computeSortPlan([]).moves.length, 0);
        assert.equal(computeSortPlan(null).moves.length, 0);
    });
});

describe('isSorted', () => {
    it('detects disorder', () => {
        assert.equal(isSorted([slot('dirt', 64), slot('bread')]), false); // blocks before food
        assert.equal(isSorted([slot('bread'), slot('dirt', 64)]), true);
    });

    it('category mapping covers the sort groups', () => {
        assert.equal(categorize('diamond_sword'), 'tools');
        assert.equal(categorize('golden_apple'), 'food');
        assert.equal(categorize('cobblestone'), 'blocks');
    });
});
