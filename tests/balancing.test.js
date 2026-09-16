import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { CHEST_SLOTS, estimatedStacks, estimatedFreeSlots, rankChests, distributeDeposits, describePlan } from '../src/agent/storage/balancing.js';
import { StorageIndex, containerKey } from '../src/agent/storage/index.js';

function chest(x, z = 0) {
    return { name: 'chest', position: new Vec3(x, 64, z) };
}

function indexWith(entries) {
    const idx = new StorageIndex();
    for (const [pos, items] of entries) idx.record('chest', pos, items);
    return idx;
}

describe('capacity estimation', () => {
    it('empty/unknown containers get full capacity', () => {
        assert.equal(estimatedFreeSlots(null), CHEST_SLOTS);
        assert.equal(estimatedFreeSlots({ items: {} }), CHEST_SLOTS);
    });

    it('stacks are ceil(count/64) per item type', () => {
        const entry = { items: { cobblestone: 130, dirt: 10 } }; // 3 + 1 stacks
        assert.equal(estimatedStacks(entry), 4);
        assert.equal(estimatedFreeSlots(entry), CHEST_SLOTS - 4);
    });

    it('never reports negative free slots', () => {
        const entry = { items: { a: 6400, b: 6400 } };
        assert.equal(estimatedFreeSlots(entry), 0);
    });
});

describe('rankChests', () => {
    it('prefers emptier chests at equal distance', () => {
        const full = chest(4);
        const empty = chest(5);
        const idx = indexWith([
            [full.position, [{ name: 'cobblestone', count: 64 * 26 }]],
            [empty.position, []]
        ]);
        const ranked = rankChests([full, empty], { index: idx, pos: new Vec3(0, 64, 0) });
        assert.equal(containerKey(ranked[0].pos), containerKey(empty.position));
        assert.equal(ranked[0].free, CHEST_SLOTS);
    });

    it('distance matters for ties', () => {
        const a = chest(3);
        const b = chest(6);
        const ranked = rankChests([b, a], { pos: new Vec3(0, 64, 0) });
        assert.equal(ranked[0].pos.x, 3);
    });

    it('caps the candidate list', () => {
        const chests = [1, 2, 3, 4, 5, 6].map(x => chest(x));
        const ranked = rankChests(chests, { pos: new Vec3(0, 64, 0), maxChests: 3 });
        assert.equal(ranked.length, 3);
    });

    it('handles missing index and positions', () => {
        const ranked = rankChests([chest(2), { name: 'chest' }], {});
        assert.equal(ranked.length, 1);
    });
});

describe('distributeDeposits', () => {
    const mkRanked = (defs) => defs.map(d => ({
        key: containerKey(d.pos), pos: d.pos, free: d.free, distance: d.distance ?? 1, score: d.free
    }));

    it('fills the emptiest chest first and respects budgets', () => {
        const small = { pos: new Vec3(2, 64, 0), free: 1 };
        const big = { pos: new Vec3(3, 64, 0), free: 5 };
        const chests = mkRanked([big, small]);
        const entries = [
            { name: 'cobblestone', count: 128 }, // needs 2 stacks
            { name: 'dirt', count: 64 }          // needs 1 stack
        ];
        const plan = distributeDeposits(entries, chests);
        const bigTarget = plan.get(containerKey(big.pos));
        assert.ok(bigTarget, 'big chest should be used');
        assert.equal(bigTarget.items.length, 2);
        assert.ok(!plan.has(containerKey(small.pos)), 'small chest lacks budget');
    });

    it('spreads across chests when one lacks capacity', () => {
        const a = { pos: new Vec3(2, 64, 0), free: 1 };
        const b = { pos: new Vec3(3, 64, 0), free: 2 };
        const chests = mkRanked([b, a]);
        const entries = [
            { name: 'cobblestone', count: 64 },
            { name: 'granite', count: 64 },
            { name: 'diorite', count: 64 }
        ];
        const plan = distributeDeposits(entries, chests);
        assert.equal(plan.size, 2, 'deposits spread across both chests');
    });

    it('reservations route matching items regardless of rank', () => {
        const ranked = mkRanked([{ pos: new Vec3(2, 64, 0), free: 10 }]);
        const resPos = { x: 30, y: 64, z: 30 };
        const reservations = [{ name: 'tools', x: resPos.x, y: resPos.y, z: resPos.z, accepts: ['iron_ingot'] }];
        const entries = [
            { name: 'iron_ingot', count: 12 },
            { name: 'cobblestone', count: 64 }
        ];
        const plan = distributeDeposits(entries, ranked, reservations);
        const resTarget = plan.get(containerKey(resPos));
        assert.ok(resTarget);
        assert.deepEqual(resTarget.items.map(i => i.name), ['iron_ingot']);
    });

    it('falls back to the best chest when nothing has budget', () => {
        const a = { pos: new Vec3(2, 64, 0), free: 0 };
        const chests = mkRanked([a]);
        const plan = distributeDeposits([{ name: 'dirt', count: 64 }], chests);
        assert.equal(plan.size, 1); // still attempts the best chest
    });

    it('ignores empty inputs gracefully', () => {
        assert.equal(distributeDeposits([], []).size, 0);
        assert.equal(distributeDeposits(null, null).size, 0);
    });
});

describe('describePlan', () => {
    it('renders one segment per chest', () => {
        const pos = new Vec3(5, 64, 5);
        const plan = new Map([[containerKey(pos), { pos, items: [{ name: 'dirt', count: 64 }] }]]);
        const text = describePlan(plan);
        assert.match(text, /\(5, 64, 5\): 64x dirt/);
    });
});
