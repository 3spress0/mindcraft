/**
 * longrun_agent.test.js — long-running agent stability test (GO list:
 * long-running agent tests). Drives the REAL autonomy loop through a
 * simulated 30-day world (day/night cycles, shifting inventories, wandering
 * hostiles, a dawn schedule) and asserts it never throws, keeps its history
 * bounded, honors the schedule, and degrades gracefully under danger.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { Vec3 } from 'vec3';
import { AutonomyLoop } from '../src/agent/autonomy/task_loop.js';
import settings from '../settings.js';

after(() => {
    try { fs.rmSync('bots/LongRunBot', { recursive: true, force: true }); } catch { /* ok */ }
});

const execLog = [];
const stubExecutors = {
    explore: async () => { execLog.push('explore'); return 'ok'; },
    farm: async () => { execLog.push('farm'); return 'ok'; },
    tool_replace: async () => { execLog.push('tool_replace'); return 'ok'; },
    inventory_full: async () => { execLog.push('inventory_full'); return 'ok'; },
    restock_torches: async () => { execLog.push('restock_torches'); return 'ok'; },
    restock_food: async () => { execLog.push('restock_food'); return 'ok'; },
    rest: async () => { execLog.push('rest'); return 'ok'; },
    maintain_base: async () => { execLog.push('maintain_base'); return 'ok'; },
    patrol: async () => { execLog.push('patrol'); return 'ok'; },
    husbandry: async () => { execLog.push('husbandry'); return 'ok'; }
};

function makeWorld(day) {
    const slots = new Array(46).fill(null);
    // evolving kit: torches dwindle, cobble piles up on later days
    slots[9] = { name: 'torch', count: Math.max(0, 12 - day * 2), slot: 9 };
    slots[10] = { name: 'bread', count: 3, slot: 10 };
    if (day > 5) slots[11] = { name: 'coal', count: 6, slot: 11 };
    if (day > 5) slots[12] = { name: 'stick', count: 12, slot: 12 };
    const hostiles = {};
    // hostile pressure varies by day/night
    if (day % 3 === 0) {
        hostiles.m1 = { name: 'zombie', position: new Vec3(9, 64, 2) };
        hostiles.m2 = { name: 'skeleton', position: new Vec3(-8, 64, 6) };
    }
    return {
        username: 'LongRunBot',
        health: 20,
        time: { timeOfDay: 6000 },
        entity: { position: new Vec3(day * 3, 64, 0) },
        entities: hostiles,
        inventory: { slots },
        blockAt: () => ({ name: 'air' }),
        lightAt: () => 15,
        lightLevelAt: () => 12,
        world: { getColumnAt: () => ({}) },
        findBlocks: () => [],
        autoEat: { options: { priority: 'foodPoints' } }
    };
}

function makeAgent(world, { scheduled = [] } = {}) {
    const ran = [];
    return {
        ran, bot: world,
        name: 'LongRunBot',
        isIdle: () => true,
        isHandlingMessage: () => false,
        idleForMs: () => 300_000,
        personality: null,
        actions: { runAction: async (label, fn) => { ran.push(label); await fn(); return { interrupted: false }; } },
        _scheduled_cfg: scheduled
    };
}

describe('long-running agent stability', () => {
    it('30 simulated days: no throws, bounded history, schedules fire', async () => {
        const savedAutonomy = settings.autonomy;
        settings.autonomy = {
            ...savedAutonomy,
            cooldown_s: [0.001, 0.002], // run every tick in the sim
            scheduled: [{ at: 'dawn', do: 'restock_torches' }]
        };
        try {
            let scheduledFired = 0;
            const executors = {
                ...stubExecutors,
                restock_torches: async (a, need) => {
                    execLog.push('restock_torches');
                    if (need.detail === 'scheduled') scheduledFired++;
                    return 'ok';
                }
            };
            for (let day = 0; day < 30; day++) {
                const world = makeWorld(day);
                const agent = makeAgent(world);
                const loop = new AutonomyLoop(agent, { now: () => Date.now() + day, executors });
                loop._nextRunAt = 0;
                // simulate times of day: dawn (schedule check) + midday + night
                for (const timeOfDay of [0, 6000, 18000]) {
                    world.time = { timeOfDay };
                    await loop.tick(); // must never throw
                    loop._nextRunAt = 0; // force next tick for the sim
                }
                assert.ok(loop.history.length <= 16, `history bounded on day ${day}`);
            }
            assert.ok(execLog.length > 0, 'the loop acted across the month');
            assert.ok(scheduledFired >= 1, 'the dawn schedule fired at least once');
            assert.ok(execLog.includes('explore') || execLog.includes('restock_torches'), 'real needs executed');
        } finally {
            settings.autonomy = savedAutonomy;
        }
    });

    it('dangerous nights never run risky needs, and overwhelm flees', async () => {
        const world = makeWorld(3); // day%3==0 -> hostiles
        world.time = { timeOfDay: 18000 };
        const agent = makeAgent(world);
        const loop = new AutonomyLoop(agent, { executors: stubExecutors });
        loop._nextRunAt = 0;
        await loop.tick();
        const riskyRan = ['explore', 'farm', 'rest', 'patrol', 'husbandry']
            .filter(k => execLog.slice(-3).includes(k));
        if (loop.lastCombat?.phase === 'fleeing') {
            assert.equal(loop.lastRun.kind, 'escape');
        } else {
            assert.deepEqual(riskyRan, [], 'no risky need may run on a dangerous night');
        }
    });

    it('pause gate: global pause blocks the loop entirely', async () => {
        const world = makeWorld(1);
        const agent = makeAgent(world);
        agent._paused = true;
        const loop = new AutonomyLoop(agent, { executors: stubExecutors });
        loop._nextRunAt = 0;
        const before = agent.ran.length;
        await loop.tick();
        assert.equal(agent.ran.length, before, 'paused agent runs nothing');
    });

    it('crash backoff blocks the loop until the window passes', async () => {
        const world = makeWorld(2);
        const agent = makeAgent(world);
        agent._autonomy_backoff_until = Date.now() + 60_000;
        const loop = new AutonomyLoop(agent, { executors: stubExecutors });
        loop._nextRunAt = 0;
        const before = agent.ran.length;
        await loop.tick();
        assert.equal(agent.ran.length, before, 'backed-off agent runs nothing');
    });
});
