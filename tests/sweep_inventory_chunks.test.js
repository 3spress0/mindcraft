/**
 * sweep_inventory_chunks.test.js — coverage for the inventory-counting /
 * desync-verification helpers and the chunk-readiness gate used by the
 * sweep (GO list: inventory tracking + navigation readiness).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getInventoryCounts } from '../src/agent/library/world.js';
import { verifyInventoryDelta } from '../src/agent/library/skills.js';
import { isChunkLoaded, loadedChunkCount, waitChunksReady } from '../src/agent/library/chunks.js';

function botWithSlots(slots) {
    return {
        username: 'SweepInvBot',
        inventory: { slots },
        _logs: []
    };
}

describe('inventory counting', () => {
    it('getInventoryCounts sums duplicates across slots and skips empties', () => {
        const bot = botWithSlots([
            { name: 'oak_log', count: 12 },
            null,
            undefined,
            { name: 'oak_log', count: 30 },
            { name: 'iron_ingot', count: 5 },
            { name: null, count: 9 } // slot with no name is skipped
        ]);
        const counts = getInventoryCounts(bot);
        assert.equal(counts.oak_log, 42);
        assert.equal(counts.iron_ingot, 5);
        assert.equal(Object.keys(counts).length, 2);
    });

    it('verifyInventoryDelta passes when the delta matches', () => {
        const bot = botWithSlots([{ name: 'bread', count: 10 }]);
        assert.equal(verifyInventoryDelta(bot, 'bread', +4, 6), null);
        assert.equal(verifyInventoryDelta(bot, 'bread', -2, 12), null);
    });

    it('verifyInventoryDelta reports a desync message when it misses', () => {
        const bot = botWithSlots([{ name: 'bread', count: 10 }]);
        const msg = verifyInventoryDelta(bot, 'bread', +4, 8); // actual +2
        assert.ok(msg, 'desync must be reported');
        assert.ok(msg.includes('desync on bread'), msg);
        assert.ok(msg.includes('+2'), 'actual delta is part of the message');
    });

    it('verifyInventoryDelta treats missing items as zero', () => {
        const bot = botWithSlots([]);
        assert.equal(verifyInventoryDelta(bot, 'diamond', 0, 0), null);
        const msg = verifyInventoryDelta(bot, 'diamond', 3, 0);
        assert.ok(msg.includes('desync'));
    });

    it('verifyInventoryDelta never throws on broken bots', () => {
        const bot = { inventory: null };
        assert.equal(verifyInventoryDelta(bot, 'bread', 1, 1), null);
    });
});

describe('chunk readiness', () => {
    it('isChunkLoaded probes the live world when no tracking is attached', () => {
        const bot = {
            world: {
                getColumnAt: ({ x, z }) => (Math.floor(x / 16) === 2 && Math.floor(z / 16) === 3 ? {} : null)
            }
        };
        assert.equal(isChunkLoaded(bot, { x: 40, y: 64, z: 55 }), true);
        assert.equal(isChunkLoaded(bot, { x: 0, y: 64, z: 0 }), false);
    });

    it('loadedChunkCount counts tracked chunks', () => {
        const bot = { _chunk_tracking: new Map([['0,0', 1], ['1,0', 1]]) };
        assert.equal(loadedChunkCount(bot), 2);
        assert.equal(loadedChunkCount({}), 0);
    });

    it('waitChunksReady resolves immediately when the chunk is already loaded', async () => {
        const bot = {
            world: { getColumnAt: () => ({}) }
        };
        const t0 = Date.now();
        const ok = await waitChunksReady(bot, { x: 0, y: 64, z: 0 }, { timeoutMs: 500 });
        assert.equal(ok, true);
        assert.ok(Date.now() - t0 < 400, 'no real waiting for loaded chunks');
    });

    it('waitChunksReady times out gracefully when the chunk never loads', async () => {
        const bot = { world: { getColumnAt: () => null } };
        const ok = await waitChunksReady(bot, { x: 100, y: 64, z: 100 }, {
            timeoutMs: 120,
            pollMs: 20,
            sleep: () => Promise.resolve()
        });
        assert.equal(ok, false);
    });

    it('waitChunksReady returns true once the chunk appears', async () => {
        let loaded = false;
        const bot = { world: { getColumnAt: () => (loaded ? {} : null) } };
        const p = waitChunksReady(bot, { x: 3, y: 64, z: 3 }, {
            timeoutMs: 5000,
            pollMs: 20,
            sleep: async () => { loaded = true; }
        });
        assert.equal(await p, true);
    });
});
