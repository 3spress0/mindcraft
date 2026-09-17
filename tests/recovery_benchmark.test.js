/**
 * recovery_benchmark.test.js — recovery benchmark (GO list). End-to-end
 * failure-recovery sequences across the real modules: interrupt→resume,
 * death→respawn bookkeeping, route-failure campaigns, partial-failure
 * executors, mid-patrol danger, and executor crashes inside the loop.
 * Unit-level recovery logic lives in recovery.test.js / humanlike tests.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { Vec3 } from 'vec3';

import { BehaviorStateMachine, STATES } from '../src/agent/humanlike/behavior_state.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';
import { MetricsTracker } from '../src/agent/library/metrics.js';
import { RouteCache } from '../src/agent/navigation/route_cache.js';
import { executeFarming } from '../src/agent/autonomy/farming.js';
import { executePatrol } from '../src/agent/autonomy/patrol.js';
import { AutonomyLoop } from '../src/agent/autonomy/task_loop.js';

const PREFIX = 'RecoveryBenchBot';
let seq = 0;

after(() => {
    for (const entry of fs.readdirSync('bots')) {
        if (entry.startsWith(PREFIX)) fs.rmSync(`bots/${entry}`, { recursive: true, force: true });
    }
});

function item(name, slot, count = 1, props = {}) {
    return { name, slot, count, type: slot, maxDurability: null, durabilityUsed: 0, ...props };
}

describe('recovery benchmark', () => {
    it('R1 — interrupted work is remembered and resumed, not dropped', () => {
        let now = 0;
        const fsm = new BehaviorStateMachine(() => now);
        fsm.beginActivity('autonomy:farm');
        assert.equal(fsm.current, STATES.ACT);

        fsm.interrupt('player chat'); // something demanded attention
        assert.equal(fsm.current, STATES.INTERRUPTED);
        assert.ok(fsm.hasPendingResume(), 'the farm run is remembered');
        assert.equal(fsm.peekPendingResume(), 'autonomy:farm');

        // while a resume is pending, bedtime does not steal the slot
        const needs = evaluateNeeds({
            tools: [], freeSlots: 20, idleForMs: 300000, isNight: true,
            inventoryCounts: {}, foodCount: 9, bedKnown: true,
            hasPendingResume: true
        }, {});
        assert.ok(!needs.some(n => n.kind === 'rest'), 'rest waits for the resume');

        now += 5000;
        fsm.recover();
        const resumed = fsm.resume();
        assert.equal(resumed, 'autonomy:farm', 'picks the interrupted activity back up');
        assert.ok(!fsm.hasPendingResume());
    });

    it('R2 — deaths and respawns are tracked and persist across sessions', () => {
        const botName = `${PREFIX}${seq++}`;
        let now = 1000;
        const m1 = new MetricsTracker({ botName, dir: 'bots', now: () => now });
        m1.recordDeath({ cause: 'zombie', pos: { x: -120.4, y: 30, z: 88 } });
        now += 3000;
        m1.recordRespawn({ pos: { x: 0, y: 64, z: 0 } });
        assert.equal(m1.deaths, 1);
        assert.equal(m1.respawns, 1);
        assert.equal(m1.lastDeath.cause, 'zombie');
        assert.equal(m1.lastDeath.x, -120.4);

        // a new session reloads the ledger — recovery knowledge survives restarts
        const m2 = new MetricsTracker({ botName, dir: 'bots', now: () => now });
        assert.equal(m2.deaths, 1);
        assert.equal(m2.respawns, 1);
        assert.equal(m2.lastDeath.cause, 'zombie');
        assert.ok(m2.sessions >= 2, 'counts the restart');
    });

    it('R3 — a route that keeps failing gets benched, success forgives it', () => {
        const botName = `${PREFIX}${seq++}`;
        let now = 0;
        const cache = new RouteCache({ botName, ttlMs: 100000, now: () => now });
        const A = { x: 0, y: 64, z: 0 };
        const B = { x: 64, y: 64, z: 64 };

        cache.recordFailure(A, B, 'default'); // trip 1 fails
        cache.recordFailure(A, B, 'default'); // trip 2 fails -> benched
        assert.ok(cache.isKnownFailure(A, B, 'default'));
        assert.equal(cache.failures.get([...cache.failures.keys()][0]).count, 2);

        // trip 3 takes the long way and succeeds -> route forgiven
        cache.put(A, B, 'default', { waypoints: [A, B], cost: 90 });
        cache.clearFailure(A, B, 'default');
        assert.ok(!cache.isKnownFailure(A, B, 'default'));
        assert.ok(cache.get(A, B, 'default'), 'the successful route is cached');
    });

    it('R4 — farming recovers from individual plant failures and keeps going', async () => {
        const blocks = [];
        const crop = (age, x) => ({
            name: 'wheat', position: new Vec3(x, 64, 0), getProperty: (k) => (k === 'age' ? age : null)
        });
        blocks.push(crop(7, 1), crop(7, 2), crop(7, 3), crop(2, 4)); // 3 mature
        let digCalls = 0;
        const bot = {
            interrupt_code: null,
            entity: { position: new Vec3(0, 64, 0) },
            inventory: { slots: [] },
            game: { gameMode: 'survival' },
            modes: { isOn: (m) => m === 'cheat' },
            chat: () => {},
            _personality: {},
            findBlocks: () => blocks.map(b => b.position),
            blockAt: (pos) => blocks.find(b => b.position.x === pos.x && b.position.z === pos.z) ?? { name: 'air', position: pos },
            dig: async () => {
                digCalls++;
                if (digCalls === 2) throw new Error('block out of reach'); // one plant resists
            }
        };
        const msg = await executeFarming({ bot }, null, {});
        assert.match(msg, /harvested 2 mature crop/, 'one failure must not abort the run');
        assert.equal(digCalls, 3, 'attempted all mature crops');
    });

    it('R5 — a patrol aborts cleanly when the route turns dangerous', async () => {
        const stops = [
            { name: 'tower', x: 20, y: 64, z: 0 },
            { name: 'gate', x: 0, y: 64, z: 20 }
        ];
        const bot = {
            interrupt_code: null,
            entity: { position: new Vec3(0, 64, 0) },
            time: { timeOfDay: 6000 },
            entities: {}, // safe at first
            modes: { isOn: (m) => m === 'cheat' },
            chat: () => {}
        };
        // after the first leg is walked, hostiles close in on the bot
        let legs = 0;
        bot.chat = () => {
            legs++;
            if (legs === 1) {
                bot.entities = {
                    z1: { name: 'zombie', position: new Vec3(2, 64, 1) },
                    s1: { name: 'skeleton', position: new Vec3(1, 64, 3) },
                    c1: { name: 'creeper', position: new Vec3(3, 64, 2) }
                };
            }
        };
        const msg = await executePatrol({ bot }, { stops, maxLegs: 4 });
        assert.match(msg, /patrol: held at stop 1/, 'stops the round instead of walking into danger');
    });

    it('R6 — an executor crash never takes the autonomy loop down', async () => {
        const agent = {
            bot: {
                username: 'CrashBot',
                time: { timeOfDay: 6000 },
                entity: { position: new Vec3(0, 64, 0) },
                entities: {},
                inventory: { slots: new Array(46).fill(null) }
            },
            isIdle: () => true,
            isHandlingMessage: () => false,
            idleForMs: () => 120000,
            actions: { runAction: async (label, fn) => { await fn(); return { interrupted: false }; } }
        };
        const loop = new AutonomyLoop(agent, {
            now: () => Date.now(),
            executors: { explore: async () => { throw new Error('pathfinder exploded'); } }
        });
        loop._nextRunAt = 0;
        await loop.tick(); // must not throw
        assert.match(loop.lastRun.result, /executor error: pathfinder exploded/);
        assert.ok(loop._nextRunAt > 0, 'cooldown scheduled; the loop will try again later');

        // and the very next tick still works once the executor is healthy
        loop._executors.explore = async () => 'explored fine';
        loop._nextRunAt = 0;
        await loop.tick();
        assert.equal(loop.lastRun.result, 'explored fine');
        assert.equal(loop.history.length, 2, 'both attempts remembered');
    });
});
