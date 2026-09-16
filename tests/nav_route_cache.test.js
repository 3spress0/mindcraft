import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
    snap, routeKey, downsample, verifyRoute, RouteCache
} from '../src/agent/navigation/route_cache.js';

const TMP = 'bots/RouteCacheTestBot';

describe('route cache primitives', () => {
    it('snap rounds to whole blocks', () => {
        assert.deepEqual(snap({ x: 1.4, y: 63.6, z: -2.5 }), { x: 1, y: 64, z: -2 });
        assert.equal(snap(null), null);
        assert.equal(snap({}), null);
    });

    it('routeKey is stable under jitter and includes the profile', () => {
        const k1 = routeKey({ x: 1.2, y: 64, z: 3.4 }, { x: 10, y: 64, z: 10 }, 'legit');
        const k2 = routeKey({ x: 0.8, y: 64.1, z: 2.6 }, { x: 10.4, y: 63.9, z: 9.7 }, 'legit');
        assert.equal(k1, k2);
        assert.notEqual(k1, routeKey({ x: 1, y: 64, z: 3 }, { x: 10, y: 64, z: 10 }, 'fast'));
        assert.equal(routeKey(null, { x: 1, y: 1, z: 1 }), null);
    });

    it('downsample keeps endpoints and bounds length', () => {
        const path = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 64, z: 0 }));
        const ds = downsample(path, 4);
        assert.deepEqual(ds[0], { x: 0, y: 64, z: 0 });
        assert.deepEqual(ds[ds.length - 1], { x: 49, y: 64, z: 0 });
        assert.ok(ds.length <= 160 && ds.length >= 2);
        assert.deepEqual(downsample([]), []);
        const single = downsample([{ x: 5, y: 64, z: 5 }], 4);
        assert.equal(single.length, 1);
    });
});

function worldBot({ breakAt = null, solidGround = true } = {}) {
    return {
        blockAt: (p) => {
            const k = `${p.x},${p.y},${p.z}`;
            if (breakAt && k === breakAt) return { name: 'lava', boundingBox: 'empty' };
            if (p.y === 63) return solidGround ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
}

describe('verifyRoute', () => {
    const route = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 64, z: 0 }));

    it('accepts an intact route', () => {
        const res = verifyRoute(worldBot(), route);
        assert.equal(res.valid, true);
        assert.ok(res.checked >= 3);
        assert.equal(res.blocked.length, 0);
    });

    it('rejects when lava appears at a sampled waypoint', () => {
        const res = verifyRoute(worldBot({ breakAt: '12,64,0' }), route, { sampleEvery: 2 });
        assert.equal(res.valid, false);
        assert.ok(res.blocked.some(b => b.x === 12));
        assert.equal(res.blocked[0].feet, 'lava');
    });

    it('rejects when the ground disappeared', () => {
        const bot = worldBot({ solidGround: false });
        const res = verifyRoute(bot, route, { sampleEvery: 2 });
        assert.equal(res.valid, false);
    });

    it('water routes are valid (swimming corridors)', () => {
        const bot = {
            blockAt: (p) => p.y === 64
                ? { name: 'water', boundingBox: 'empty' }
                : { name: 'air', boundingBox: 'empty' }
        };
        const res = verifyRoute(bot, route, { sampleEvery: 4 });
        assert.equal(res.valid, true);
    });

    it('empty routes are invalid', () => {
        assert.equal(verifyRoute(worldBot(), []).valid, false);
        assert.equal(verifyRoute(worldBot(), null).valid, false);
    });
});

describe('RouteCache', () => {
    it('put/get round-trip with ttl and profile separation', () => {
        let now = 1000;
        const cache = new RouteCache({ botName: 'RouteCacheTestBot', ttlMs: 60000, maxEntries: 8, now: () => now });
        const from = { x: 0, y: 64, z: 0 }, to = { x: 40, y: 64, z: 40 };
        const key = cache.put(from, to, 'legit', { waypoints: [{ x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 40 }], cost: 12 });
        assert.ok(key);
        assert.ok(cache.get(from, to, 'legit'));
        assert.equal(cache.get(from, to, 'fast'), null);
        now += 61000;
        assert.equal(cache.get(from, to, 'legit'), null, 'expired after ttl');
    });

    it('prunes to maxEntries keeping newest', () => {
        let now = 0;
        const cache = new RouteCache({ botName: 'RouteCacheTestBot', ttlMs: 1e9, maxEntries: 4, now: () => now });
        for (let i = 0; i < 8; i++) {
            now += 1000;
            cache.put({ x: 0, y: 64, z: 0 }, { x: i, y: 64, z: i }, 'default', { waypoints: [{ x: 0, y: 64, z: 0 }, { x: i, y: 64, z: i }] });
        }
        assert.equal(cache.stats().entries, 4);
        assert.ok(cache.get({ x: 0, y: 64, z: 0 }, { x: 7, y: 64, z: 7 }, 'default'), 'newest survives');
        assert.equal(cache.get({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 'default'), null, 'oldest pruned');
    });

    it('invalidate and clear behave', () => {
        const cache = new RouteCache({ botName: 'RouteCacheTestBot', ttlMs: 1e9, maxEntries: 8, now: () => 0 });
        const from = { x: 1, y: 64, z: 1 }, to = { x: 9, y: 64, z: 9 };
        cache.put(from, to, 'default', { waypoints: [{ x: 1, y: 64, z: 1 }, { x: 9, y: 64, z: 9 }] });
        assert.equal(cache.invalidate(from, to, 'default'), true);
        assert.equal(cache.get(from, to, 'default'), null);
        assert.equal(cache.invalidate(from, to, 'default'), false);
        cache.put(from, to, 'default', { waypoints: [{ x: 1, y: 64, z: 1 }, { x: 9, y: 64, z: 9 }] });
        assert.equal(cache.clear(), 1);
        assert.equal(cache.stats().entries, 0);
    });

    it('rejects degenerate waypoints', () => {
        const cache = new RouteCache({ botName: 'RouteCacheTestBot', now: () => 0 });
        assert.equal(cache.put({ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 5 }, 'default', { waypoints: [{ x: 0, y: 64, z: 0 }] }), null);
    });

    it('persists and reloads atomically, dropping expired entries', () => {
        try {
            let now = 1000;
            const a = new RouteCache({ botName: 'RouteCacheTestBot', ttlMs: 5000, maxEntries: 8, now: () => now });
            a.put({ x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 0 }, 'legit', { waypoints: [{ x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 0 }] });
            now += 1000;
            a.put({ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }, 'legit', { waypoints: [{ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }] });
            assert.ok(fs.existsSync(a.fp));

            now += 4500; // first entry expires, second survives
            const b = new RouteCache({ botName: 'RouteCacheTestBot', ttlMs: 5000, maxEntries: 8, now: () => now }).load();
            assert.equal(b.stats().entries, 1);
            assert.ok(b.get({ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }, 'legit'));
        } finally {
            fs.rmSync('bots/RouteCacheTestBot', { recursive: true, force: true });
        }
    });
});
