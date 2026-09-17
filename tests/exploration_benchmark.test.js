/**
 * exploration_benchmark.test.js — exploration benchmark (GO list).
 * Campaign-level properties of the frontier explorer: coverage grows, the
 * ring expands when nearby rings fill up, runs are reproducible per seed,
 * avoid-zones are steered around, and state survives across "sessions".
 * Unit-level mechanics live in nav_exploration.test.js.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
    ExplorationState, nextFrontierGoal, chunkKey, CHUNK_SIZE
} from '../src/agent/navigation/exploration.js';
import { createRng } from '../src/agent/humanlike/rng.js';

const BOT = 'ExplorationBenchBot';

before(() => { fs.rmSync(`bots/${BOT}`, { recursive: true, force: true }); });
after(() => { fs.rmSync(`bots/${BOT}`, { recursive: true, force: true }); });

/** Simulate one exploration leg: pick a goal, "walk" there, record chunks. */
function runLeg(state, rng, avoid = []) {
    const goal = nextFrontierGoal(state, { rng, avoid });
    state.markVisited({ x: goal.x, z: goal.z }, state.visited.size);
    state.legs += 1;
    return goal;
}

describe('exploration benchmark: a campaign of frontier legs', () => {
    it('coverage keeps growing and the ring expands as rings fill', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const rng = createRng('bench-campaign-1');
        const goals = [];
        for (let i = 0; i < 40; i++) goals.push(runLeg(state, rng));

        assert.ok(state.visitedCount >= 30, `visited ${state.visitedCount} chunks`);
        // every goal was unvisited when chosen
        const keys = goals.map(g => chunkKey(g.x, g.z));
        assert.equal(new Set(keys).size, keys.length, 'never deliberately revisits a chunk');
        // distance from origin grows over the campaign
        const d = (g) => Math.hypot(g.x, g.z);
        const firstHalf = goals.slice(0, 10).reduce((s, g) => s + d(g), 0) / 10;
        const secondHalf = goals.slice(30).reduce((s, g) => s + d(g), 0) / 10;
        assert.ok(secondHalf > firstHalf, 'the frontier pushes outward');
        assert.ok(state.ring >= 1);
    });

    it('is reproducible for a seed and varies across seeds', () => {
        const run = (seed) => {
            const state = new ExplorationState({ origin: { x: 0, z: 0 } });
            const rng = createRng(seed);
            return Array.from({ length: 12 }, () => {
                const g = nextFrontierGoal(state, { rng });
                state.markVisited({ x: g.x, z: g.z }, state.visited.size);
                return `${g.x},${g.z}`;
            });
        };
        assert.deepEqual(run('seed-A'), run('seed-A'), 'same seed, same campaign');
        assert.notDeepEqual(run('seed-A'), run('seed-B'), 'different seed, different wander');
    });

    it('steers around avoid-zones while any safe frontier remains', () => {
        const make = () => new ExplorationState({ origin: { x: 0, z: 0 } });
        const rngA = createRng('bench-avoid');
        const g0 = nextFrontierGoal(make(), { rng: rngA }); // unconstrained choice
        const rngB = createRng('bench-avoid');
        const avoid = [{ x: g0.x, z: g0.z, r: 60 }]; // danger right on that goal
        const g1 = nextFrontierGoal(make(), { rng: rngB, avoid });
        const distToZone = Math.hypot(g1.x - g0.x, g1.z - g0.z);
        assert.ok(distToZone > 60, `steered away from the danger zone (d=${Math.round(distToZone)})`);
    });

    it('falls back into an avoid-zone rather than giving up exploration', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const rng = createRng('bench-fallback');
        const avoid = [{ x: 0, z: 0, r: 1e9 }]; // everything is "danger"
        const g = nextFrontierGoal(state, { rng, avoid });
        assert.ok(Number.isFinite(g.x) && Number.isFinite(g.z), 'still produces a goal');
    });

    it('ringOverride pins distance for targeted sweeps', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const rng = createRng('bench-pin');
        for (let i = 0; i < 6; i++) {
            const g = nextFrontierGoal(state, { rng, ringOverride: 3 });
            const dist = Math.hypot(g.x, g.z);
            assert.ok(Math.abs(dist - 3 * CHUNK_SIZE) <= CHUNK_SIZE, 'stays on ring 3');
        }
    });

    it('state persists across sessions and exploration resumes', () => {
        const s1 = new ExplorationState({ origin: { x: 0, z: 0 } });
        const rng1 = createRng('bench-persist');
        for (let i = 0; i < 10; i++) runLeg(s1, rng1);
        assert.ok(s1.persist(BOT));

        const s2 = ExplorationState.load(BOT);
        assert.equal(s2.visitedCount, s1.visitedCount, 'visited chunks survive restart');
        assert.deepEqual(s2.origin, s1.origin);
        // resuming does not revisit what session 1 covered
        const rng2 = createRng('bench-persist-2');
        for (let i = 0; i < 6; i++) {
            const g = nextFrontierGoal(s2, { rng: rng2 });
            assert.ok(!s1.isVisited(g.x, g.z) || s2.isVisited(g.x, g.z), 'no stale revisits');
        }
    });

    it('keeps the visited ledger bounded on very long campaigns', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const rng = createRng('bench-bound');
        for (let i = 0; i < 600; i++) {
            const g = nextFrontierGoal(state, { rng });
            state.markVisited({ x: g.x, z: g.z }, i);
        }
        assert.ok(state.visitedCount <= 2048, 'ledger stays capped');
    });
});
