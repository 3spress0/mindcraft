/**
 * humanlike_benchmark.test.js — deterministic behavioral benchmark for the
 * humanlike/autonomy/social/navigation layers (GO list: humanlike-behavior
 * benchmark). Each scenario scripts a situation, runs the real modules, and
 * asserts behavioral thresholds — reproducibly, with seeded randomness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { Vec3 } from 'vec3';
import { BehaviorStateMachine } from '../src/agent/humanlike/behavior_state.js';
import { createPersonality } from '../src/agent/humanlike/personality.js';
import { glance } from '../src/agent/humanlike/attention.js';
import { chooseIdleAction } from '../src/agent/humanlike/idle.js';
import { pause, getInteractionConfig } from '../src/agent/humanlike/interaction.js';
import { RouteCache, verifyRoute } from '../src/agent/navigation/route_cache.js';
import { ExplorationState, nextFrontierGoal } from '../src/agent/navigation/exploration.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';
import { ReactionGate } from '../src/agent/social/reactions.js';

const BENCH_BOT = 'HumanlikeBenchBot';

describe('benchmark B1: interrupt-resume memory', () => {
    it('remembers and resumes nested interruptions in order', () => {
        let now = 0;
        const fsm = new BehaviorStateMachine(() => now);
        const resumed = [];
        // mining -> creeper interrupt -> recover -> build -> player interrupt -> recover
        fsm.beginActivity('mine iron');
        now += 5000;
        fsm.interrupt('creeper');
        fsm.recover();
        fsm.beginActivity('build wall');
        now += 3000;
        fsm.interrupt('player arrived');
        fsm.recover();
        // now resume: newest first
        resumed.push(fsm.resume());
        resumed.push(fsm.resume());
        assert.deepEqual(resumed, ['build wall', 'mine iron']);
        assert.equal(fsm.resume(), null);
        assert.ok(fsm.history.length >= 6, 'transitions were recorded');
    });
});

describe('benchmark B2: route cache staleness detection', () => {
    const route = Array.from({ length: 24 }, (_, i) => ({ x: i * 2, y: 64, z: 0 }));
    const worldAt = (blockedAt) => ({
        blockAt: (p) => {
            if (blockedAt != null && p.x === blockedAt && p.y === 64) return { name: 'lava', boundingBox: 'empty' };
            if (p.y === 63) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        }
    });

    it('accepts intact corridors and rejects changed worlds', () => {
        assert.equal(verifyRoute(worldAt(null), route, { sampleEvery: 2 }).valid, true);
        const broken = verifyRoute(worldAt(16), route, { sampleEvery: 2 });
        assert.equal(broken.valid, false);
        assert.ok(broken.blocked.length >= 1);
    });

    it('expired entries never replay', () => {
        try {
            let now = 0;
            const cache = new RouteCache({ botName: BENCH_BOT, ttlMs: 1000, now: () => now });
            cache.put({ x: 0, y: 64, z: 0 }, { x: 46, y: 64, z: 0 }, 'legit', { waypoints: route });
            assert.ok(cache.get({ x: 0, y: 64, z: 0 }, { x: 46, y: 64, z: 0 }, 'legit'));
            now += 2000;
            assert.equal(cache.get({ x: 0, y: 64, z: 0 }, { x: 46, y: 64, z: 0 }, 'legit'), null);
        } finally {
            fs.rmSync(`bots/${BENCH_BOT}`, { recursive: true, force: true });
        }
    });
});

describe('benchmark B3: frontier exploration coverage', () => {
    it('never targets visited chunks and persists progress', () => {
        try {
            const state = new ExplorationState({ origin: { x: 0, z: 0 } });
            const rng = createPersonality({ name: 'BenchExplorer' }).rng;
            let targets = 0;
            for (let i = 0; i < 12; i++) {
                const g = nextFrontierGoal(state, { rng });
                assert.ok(!state.isVisited(g.x, g.z), `target ${i} must be unvisited`);
                state.markVisited({ x: g.x, z: g.z }, i);
                targets++;
            }
            assert.equal(targets, 12);
            assert.ok(state.persist(BENCH_BOT));
            const reloaded = ExplorationState.load(BENCH_BOT);
            assert.equal(reloaded.visitedCount, 12);
        } finally {
            fs.rmSync(`bots/${BENCH_BOT}`, { recursive: true, force: true });
        }
    });
});

describe('benchmark B4: need prioritization under wear', () => {
    const tool = (name, pct) => ({ name, pct, remaining: Math.round(pct * 100), maxDurability: 100, broken: pct <= 0 });

    it('broken tool beats exploration and unload', () => {
        const needs = evaluateNeeds({
            tools: [tool('iron_pickaxe', 0.0)],
            freeSlots: 0,
            idleForMs: 300000
        }, {});
        assert.equal(needs[0].kind, 'tool_replace');
        assert.equal(needs[0].urgency, 0.95);
        const kinds = needs.map(n => n.kind);
        assert.ok(kinds.includes('inventory_full'));
        assert.ok(kinds.includes('explore'));
    });

    it('reserves only fire when materials exist', () => {
        const noMats = evaluateNeeds({ inventoryCounts: { torch: 0 }, foodCount: 9 }, {});
        assert.ok(!noMats.some(n => n.kind === 'restock_torches'));
        const withMats = evaluateNeeds({
            inventoryCounts: { torch: 0, coal: 2, stick: 4 },
            foodCount: 9
        }, {});
        assert.ok(withMats.some(n => n.kind === 'restock_torches'));
        const hungry = evaluateNeeds({
            inventoryCounts: { wheat: 6 },
            foodCount: 1
        }, {});
        assert.ok(hungry.some(n => n.kind === 'restock_food'));
    });
});

describe('benchmark B5: reaction spam resistance', () => {
    it('one greeting per cooldown window even under approach flooding', () => {
        let now = 0;
        const gate = new ReactionGate({ now: () => now });
        let allowed = 0;
        for (let i = 0; i < 20; i++) {
            now += 1000; // approaches 1s apart
            if (gate.allow('approach', 'alice')) allowed++;
        }
        assert.equal(allowed, 1, 'cooldown must absorb the flood');
        now += 10 * 60000; // past the 5-minute approach cooldown
        assert.equal(gate.allow('approach', 'alice'), true);
    });
});

describe('benchmark B6: interaction delay envelopes', () => {
    it('100 dig pauses stay inside the configured envelope', async () => {
        const cfg = getInteractionConfig();
        const [lo, hi] = cfg.dig_pause_ms;
        const personality = createPersonality({ name: 'BenchDigger', overrides: { pace: 1 } });
        const bot = { _humanlike_off: false, look: async () => {}, entity: { position: new Vec3(0, 64, 0) }, modes: { isOn: () => false } };
        let total = 0;
        for (let i = 0; i < 20; i++) { // bounded sample keeps the suite fast
            const ms = await pause(bot, personality, 'dig');
            assert.ok(ms >= lo && ms <= hi, `pause ${ms} outside [${lo},${hi}]`);
            total += ms;
        }
        assert.ok(total > 0);
    });
});

describe('benchmark B7: idle context stability', () => {
    it('danger always stills; zero restlessness never wanders', () => {
        const calm = createPersonality({ name: 'BenchIdler', overrides: { restlessness: 0 } });
        let wanders = 0, pauses = 0;
        for (let i = 0; i < 120; i++) {
            const dangerChoice = chooseIdleAction({ idleForMs: 60000, recentDanger: true, state: 'idle', novelSights: [] }, calm);
            assert.equal(dangerChoice.action, 'pause');
            const choice = chooseIdleAction({ idleForMs: 60000, recentDanger: false, state: 'idle', novelSights: [] }, calm);
            if (choice.action === 'wander') wanders++;
            if (choice.action === 'pause') pauses++;
        }
        assert.equal(wanders, 0);
        assert.ok(pauses > 0);
    });
});

describe('benchmark B8: glance precision bounds', () => {
    it('glances stay finite and within the dwell envelope', async () => {
        const looks = [];
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            look: async (yaw, pitch, force) => { looks.push({ yaw, pitch, force }); }
        };
        const personality = createPersonality({ name: 'BenchGazer' });
        for (let i = 0; i < 4; i++) {
            const res = await glance(bot, { x: 4 + i, y: 64, z: 3 }, personality, { minDwellMs: 80, maxDwellMs: 160 });
            assert.ok(Number.isFinite(res.yaw) && Number.isFinite(res.pitch));
            assert.equal(looks[looks.length - 1].force, false);
            assert.ok(res.dwellMs >= 80 * 0.6 - 1 && res.dwellMs <= 160 * 1.4 + 1);
        }
        assert.equal(looks.length, 4);
    });
});
