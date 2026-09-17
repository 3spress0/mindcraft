/**
 * navigation_benchmark.test.js — deterministic navigation benchmark (GO list:
 * navigation benchmark). Exercises the real route-cache, hazard-hardening,
 * route-choice, and exploration modules against scripted worlds and asserts
 * behavioral thresholds: replay integrity, cache hygiene under churn, safe
 * route selection under hazard fields, and frontier consistency.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { RouteCache, verifyRoute, downsample, snap } from '../src/agent/navigation/route_cache.js';
import { hardenMovements, HARD_HAZARDS, SOFT_HAZARDS } from '../src/agent/navigation/hazards.js';
import { chooseSaferRoute, routeLength } from '../src/agent/navigation/route_choice.js';
import { ExplorationState, nextFrontierGoal } from '../src/agent/navigation/exploration.js';

const BENCH_BOT = 'NavigationBenchBot';

before(() => { fs.rmSync(`bots/${BENCH_BOT}`, { recursive: true, force: true }); });
after(() => { fs.rmSync(`bots/${BENCH_BOT}`, { recursive: true, force: true }); });

function corridorWorld(blockedAt = null) {
    return {
        blockAt: (p) => {
            if (blockedAt != null && p.x === blockedAt && p.y === 64) return { name: 'lava', boundingBox: 'empty' };
            if (p.y === 63) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
}

describe('nav bench N1: route replay integrity at scale', () => {
    it('verifies long corridors and rejects any broken link', () => {
        const route = Array.from({ length: 60 }, (_, i) => ({ x: i * 2, y: 64, z: 0 }));
        assert.equal(verifyRoute(corridorWorld(null), route, { sampleEvery: 2 }).valid, true);
        for (const brokenAt of [8, 60, 112]) {
            const res = verifyRoute(corridorWorld(brokenAt), route, { sampleEvery: 2 });
            assert.equal(res.valid, false, `corruption at x=${brokenAt} must invalidate`);
        }
    });

    it('downsampling keeps endpoints and is idempotent within stride', () => {
        const path = Array.from({ length: 41 }, (_, i) => ({ x: i, y: 64, z: 0 }));
        const ds = downsample(path, 4);
        assert.ok(ds.length < path.length);
        assert.deepEqual(ds[0], path[0]);
        assert.deepEqual(ds[ds.length - 1], path[path.length - 1]);
        const ds2 = downsample(ds, 1);
        assert.equal(ds2.length, ds.length);
    });

    it('snap is deterministic', () => {
        assert.deepEqual(snap({ x: 1.9, y: 64.2, z: -3.7 }), snap({ x: 1.9, y: 64.2, z: -3.7 }));
    });
});

describe('nav bench N2: cache hygiene under churn', () => {
    it('evicts oldest entries at capacity and never serves expired routes', () => {
        let now = 0;
        const cache = new RouteCache({ botName: BENCH_BOT, ttlMs: 5000, maxEntries: 8, now: () => now });
        for (let i = 0; i < 20; i++) {
            now = i * 100;
            cache.put({ x: 0, y: 64, z: 0 }, { x: i * 10, y: 64, z: 10 }, 'legit', {
                waypoints: [{ x: 0, y: 64, z: 0 }, { x: i * 10, y: 64, z: 10 }]
            });
        }
        assert.ok(cache.entries.size <= 8, `cache over capacity: ${cache.entries.size}`);
        // the newest survived, the oldest was evicted
        assert.ok(cache.get({ x: 0, y: 64, z: 0 }, { x: 190, y: 64, z: 10 }, 'legit'));
        assert.equal(cache.get({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 10 }, 'legit'), null);
        // expiry beats recency of lookup
        now += 10000;
        assert.equal(cache.get({ x: 0, y: 64, z: 0 }, { x: 190, y: 64, z: 10 }, 'legit'), null);
    });

    it('invalidate removes exactly one route', () => {
        let now = 0;
        const cache = new RouteCache({ botName: BENCH_BOT, ttlMs: 9999, now: () => now });
        cache.put({ x: 1, y: 64, z: 1 }, { x: 9, y: 64, z: 9 }, 'default', { waypoints: [{ x: 1, y: 64, z: 1 }, { x: 9, y: 64, z: 9 }] });
        assert.equal(cache.invalidate({ x: 1, y: 64, z: 1 }, { x: 9, y: 64, z: 9 }, 'default'), true);
        assert.equal(cache.invalidate({ x: 1, y: 64, z: 1 }, { x: 9, y: 64, z: 9 }, 'default'), false);
    });
});

describe('nav bench N3: hazard hardening', () => {
    it('adds hard hazards, and soft ones only when included', () => {
        const registryIds = {};
        let nextId = 1;
        for (const n of [...HARD_HAZARDS, ...SOFT_HAZARDS]) registryIds[n] = { id: nextId++ };
        const bot = { registry: { blocksByName: registryIds } };

        const hardOnly = { blocksToAvoid: new Set() };
        hardenMovements(hardOnly, bot, { includeSoft: false });
        assert.equal(hardOnly.blocksToAvoid.size, HARD_HAZARDS.length);

        const full = { blocksToAvoid: new Set() };
        hardenMovements(full, bot, { includeSoft: true });
        assert.equal(full.blocksToAvoid.size, new Set([...HARD_HAZARDS, ...SOFT_HAZARDS]).size);
    });

    it('survives a bot without a registry', () => {
        const mv = { blocksToAvoid: new Set() };
        assert.equal(hardenMovements(mv, {}, {}), mv);
        assert.equal(hardenMovements(null, {}, {}), null);
    });
});

describe('nav bench N4: safe route selection under hazard fields', () => {
    it('pays a bounded detour to avoid lava, refuses absurd ones', () => {
        const lavaField = Array.from({ length: 9 }, (_, i) => ({ name: 'lava', tier: 'hard', x: 4 + i * 0.5, z: 0 }));
        const straight = { waypoints: Array.from({ length: 11 }, (_, i) => ({ x: i * 2, y: 64, z: 0 })) };
        const smallDetour = { waypoints: Array.from({ length: 11 }, (_, i) => ({ x: i * 2, y: 64, z: 12 })) };
        const hugeDetour = { waypoints: Array.from({ length: 11 }, (_, i) => ({ x: i * 2, y: 64, z: 120 })) };

        const { index } = chooseSaferRoute([straight, smallDetour, hugeDetour], lavaField, { corridor: 4, riskWeight: 8 });
        assert.equal(index, 1, 'moderate detour wins over both danger and absurdity');

        // without hazards, the straight line wins on length alone
        const safe = chooseSaferRoute([straight, smallDetour, hugeDetour], [], {});
        assert.equal(safe.index, 0);
    });

    it('scores are monotonic in exposure', () => {
        const hazards = [{ name: 'lava', tier: 'hard', x: 10, z: 0 }];
        const routes = [0, 6, 24].map(off => ({
            waypoints: Array.from({ length: 6 }, (_, i) => ({ x: i * 4, y: 64, z: off }))
        }));
        const { scores } = chooseSaferRoute(routes, hazards, { corridor: 4, riskWeight: 8 });
        assert.ok(scores[0] > scores[1], 'closer to hazard costs more');
        assert.ok(routeLength(routes[0].waypoints) <= routeLength(routes[1].waypoints));
    });
});

describe('nav bench N5: frontier exploration consistency', () => {
    it('30 goals never revisit visited chunks and persist the record', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const rng = { range: (lo) => lo }; // deterministic minimal jitter
        for (let i = 0; i < 30; i++) {
            const g = nextFrontierGoal(state, { rng });
            assert.ok(!state.isVisited(g.x, g.z), `goal ${i} revisits a chunk`);
            state.markVisited({ x: g.x, z: g.z }, i);
        }
        assert.ok(state.persist(BENCH_BOT));
        const reloaded = ExplorationState.load(BENCH_BOT);
        assert.equal(reloaded.visitedCount, 30);
        // after reload, the next goal still avoids everything visited
        const g = nextFrontierGoal(reloaded, { rng });
        assert.ok(!reloaded.isVisited(g.x, g.z));
    });

    it('avoid-zones steer but never deadlock exploration', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const zones = [{ x: 0, z: 0, r: 2000 }]; // everything avoided
        for (let i = 0; i < 5; i++) {
            const g = nextFrontierGoal(state, { rng: { range: () => 0 }, avoid: zones });
            assert.ok(g && typeof g.x === 'number', 'fallback must produce a goal');
            state.markVisited({ x: g.x, z: g.z }, i);
        }
    });
});
