import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { RouteCache } from '../src/agent/navigation/route_cache.js';

// One bot dir per cache instance: save() is debounced 300ms, so isolated files
// keep tests deterministic regardless of scheduling order.
const PREFIX = 'RouteFailureBenchBot';
let seq = 0;

after(() => {
    for (const entry of fs.readdirSync('bots')) {
        if (entry.startsWith(PREFIX)) fs.rmSync(`bots/${entry}`, { recursive: true, force: true });
    }
});

function makeCache(ttlMs = 5000) {
    let now = 0;
    const cache = new RouteCache({ botName: `${PREFIX}${seq++}`, ttlMs, maxEntries: 8, now: () => now });
    return { cache, tick: (t) => { now = t; } };
}

const A = { x: 0, y: 64, z: 0 };
const B = { x: 40, y: 64, z: 10 };

describe('known-failed routes', () => {
    it('records failures and reports them until TTL', () => {
        const { cache: c, tick } = makeCache(5000);
        assert.equal(c.isKnownFailure(A, B, 'default'), false);
        const f = c.recordFailure(A, B, 'default');
        assert.equal(f.count, 1);
        assert.equal(c.isKnownFailure(A, B, 'default'), true);
        c.recordFailure(A, B, 'default');
        assert.equal([...c.failures.values()][0].count, 2);
        tick(6000); // past TTL
        assert.equal(c.isKnownFailure(A, B, 'default'), false, 'failures expire with the TTL');
    });

    it('failures are per-route and per-profile', () => {
        const { cache: c } = makeCache();
        c.recordFailure(A, B, 'default');
        assert.equal(c.isKnownFailure(A, B, 'safe'), false);
        assert.equal(c.isKnownFailure(B, A, 'default'), false);
    });

    it('clearFailure forgives after a successful trip', () => {
        const { cache: c } = makeCache();
        c.recordFailure(A, B, 'default');
        assert.equal(c.clearFailure(A, B, 'default'), true);
        assert.equal(c.isKnownFailure(A, B, 'default'), false);
        assert.equal(c.clearFailure(A, B, 'default'), false);
    });

    it('persists and reloads failures', () => {
        const { cache: c } = makeCache(100000);
        c.recordFailure(A, B, 'legit');
        c.persist();
        const reloaded = new RouteCache({ botName: c.botName, ttlMs: 100000, now: () => 0 }).load();
        assert.equal(reloaded.isKnownFailure(A, B, 'legit'), true);
    });

    it('expired failures do not survive reload', () => {
        const { cache: c, tick } = makeCache(1000);
        c.recordFailure(A, B, 'fast');
        tick(5000);
        c.persist();
        const reloaded = new RouteCache({ botName: c.botName, ttlMs: 1000, now: () => 5000 }).load();
        assert.equal(reloaded.isKnownFailure(A, B, 'fast'), false);
    });

    it('caps the failure ledger', () => {
        const { cache: c } = makeCache();
        for (let i = 0; i < 20; i++) {
            c.recordFailure({ x: i, y: 64, z: 0 }, { x: i + 5, y: 64, z: 0 }, 'default');
        }
        assert.ok(c.failures.size <= 8);
    });
});
