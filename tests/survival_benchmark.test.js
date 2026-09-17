/**
 * survival_benchmark.test.js — end-to-end survival benchmark (GO list:
 * survival benchmark). Drives the REAL autonomy loop (needs evaluation +
 * risk-aware gating) across a simulated multi-day world and asserts the bot
 * makes the right survival decisions at each moment.
 *
 * Heavy I/O executors are stubbed so the benchmark measures *decision quality*
 * (which need fires, when risk suppresses it) rather than pathfinding speed —
 * those mechanics have their own unit suites.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { AutonomyLoop } from '../src/agent/autonomy/task_loop.js';
import settings from '../settings.js';

/** Stub executors record which need the loop chose to run. */
const CHOICES = {};
const stubExecutors = {
    tool_replace: async (a, need) => { CHOICES.last = `tool_replace:${need.detail}`; return CHOICES.last; },
    inventory_full: async () => { CHOICES.last = 'inventory_full'; return CHOICES.last; },
    restock_torches: async () => { CHOICES.last = 'restock_torches'; return CHOICES.last; },
    restock_food: async () => { CHOICES.last = 'restock_food'; return CHOICES.last; },
    farm: async (a, need) => { CHOICES.last = `farm:${need.detail}`; return CHOICES.last; },
    rest: async () => { CHOICES.last = 'rest'; return CHOICES.last; },
    maintain_base: async (a, need) => { CHOICES.last = 'maintain_base'; return CHOICES.last; },
    patrol: async (a, need, needsCfg) => { CHOICES.last = `patrol:${(needsCfg?.patrol_pois ?? []).length}pois`; return CHOICES.last; },
    explore: async () => { CHOICES.last = 'explore'; return CHOICES.last; }
};

function item(name, slot, count = 1, extra = {}) {
    return { name, slot, count, type: slot, maxDurability: null, durabilityUsed: 0, ...extra };
}

/**
 * Build an idle agent over a controllable world snapshot.
 * spec: { time, hostiles, slots, idleMs, posture, foods, crops }
 */
function makeAgent(spec = {}) {
    const slots = new Array(46).fill(null);
    for (const it of spec.slots ?? []) slots[it.slot] = it;
    const hostiles = {};
    (spec.hostiles ?? []).forEach((h, i) => {
        hostiles[`mob${i}`] = { name: h.name, position: new Vec3(h.x ?? 8, 64, h.z ?? 0) };
    });
    // crops the farm scan "sees"
    const cropBlocks = (spec.matureCrops ?? []).map((c, i) => ({
        name: 'wheat', position: new Vec3(2 + i, 64, 2), getProperty: (k) => (k === 'age' ? 7 : null)
    }));
    const bot = {
        username: 'SurvivalBot',
        time: { timeOfDay: spec.time ?? 6000 },
        entity: { position: new Vec3(0, 64, 0) },
        entities: hostiles,
        inventory: { slots },
        // farm scan + nearest-chest probes
        findBlocks: () => cropBlocks.map(b => b.position),
        blockAt: (pos) => cropBlocks.find(b => b.position.x === pos.x && b.position.z === pos.z) ?? { name: 'air', position: pos },
        // base-lighting probe: dark patch near origin when the spec says so
        lightAt: spec.dark
            ? (pos) => (Math.abs(pos.x) <= 1 && Math.abs(pos.z) <= 1 ? 1 : 14)
            : () => 15
    };
    if (spec.posture) bot._risk_profile = spec.posture;
    const ran = [];
    return {
        ran, bot,
        isIdle: () => true,
        isHandlingMessage: () => false,
        idleForMs: () => spec.idleMs ?? 120000,
        // bedtime + base context
        mental_map: spec.bed ? { list: ({ type } = {}) => (type === 'bed' ? [{ name: 'bed' }] : []) } : undefined,
        memory_bank: spec.home ? { recallPlace: (k) => (k === 'home' ? [0, 64, 0] : null) } : undefined,
        actions: { runAction: async (label, fn) => { ran.push(label); await fn(); return { interrupted: false }; } }
    };
}

async function tickOnce(agent) {
    CHOICES.last = null;
    const loop = new AutonomyLoop(agent, { now: () => Date.now(), executors: stubExecutors });
    loop._nextRunAt = 0;
    await loop.tick();
    return { choice: CHOICES.last, loop };
}

describe('survival benchmark: a simulated week of decisions', () => {
    it('day 1 morning — healthy and idle → explores', async () => {
        const agent = makeAgent({ time: 6000, idleMs: 120000 });
        const { choice, loop } = await tickOnce(agent);
        assert.equal(choice, 'explore');
        assert.deepEqual(agent.ran, ['autonomy:explore']);
        assert.equal(loop.lastRisk.level, 'none');
    });

    it('day 1 midday — a nearly-dead pickaxe preempts exploration', async () => {
        const agent = makeAgent({
            time: 6000, idleMs: 120000,
            slots: [item('iron_pickaxe', 9, 1, { maxDurability: 250, durabilityUsed: 245 })]
        });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'tool_replace:iron_pickaxe');
    });

    it('day 1 afternoon — full inventory routes to storage', async () => {
        const slots = [];
        for (let s = 9; s <= 44; s++) slots.push(item('cobblestone', s, 64));
        const agent = makeAgent({ time: 8000, idleMs: 120000, slots });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'inventory_full');
    });

    it('night with hostiles — risky work is held, safe upkeep proceeds', async () => {
        // hungry-ish but the safe, craftable response is torches
        const agent = makeAgent({
            time: 18000, idleMs: 120000,
            hostiles: [{ name: 'zombie', x: 7 }, { name: 'skeleton', x: 0, z: 9 }],
            slots: [item('coal', 9, 4), item('stick', 10, 8), item('bread', 11, 2)]
        });
        const { choice, loop } = await tickOnce(agent);
        assert.equal(loop.lastRisk.level, 'high');
        // exploration would be a need when idle, but risk holds it; torches craft safely
        assert.equal(choice, 'restock_torches');
    });

    it('night with hostiles — a held risky action is recorded in history', async () => {
        const agent = makeAgent({
            time: 18000, idleMs: 120000,
            hostiles: [{ name: 'zombie', x: 7 }, { name: 'skeleton', x: 0, z: 9 }, { name: 'creeper', x: 4, z: 4 }],
            slots: [item('bread', 9, 5)] // food fine, no torch materials -> nothing safe to run
        });
        const { choice, loop } = await tickOnce(agent);
        assert.equal(loop.lastRisk.level, 'high');
        assert.equal(choice, null); // nothing safe executed
        // explore was a candidate but held
        const held = loop.history.find(h => h.result?.startsWith('held'));
        assert.ok(held, 'expected a held entry');
        assert.equal(held.kind, 'explore');
    });

    it('day 2 — hungry with wheat on hand → crafts bread', async () => {
        const agent = makeAgent({
            time: 6000, idleMs: 120000,
            slots: [item('wheat', 9, 6)]
        });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'restock_food');
    });

    it('day 2 — hungry, no wheat, mature crops → harvests', async () => {
        const agent = makeAgent({
            time: 6000, idleMs: 120000,
            matureCrops: [1, 2, 3]
        });
        const { choice } = await tickOnce(agent);
        assert.match(choice ?? '', /^farm:harvest/);
    });

    it('bold posture near a lone mob still explores', async () => {
        const agent = makeAgent({
            time: 6000, idleMs: 120000, posture: 'bold',
            hostiles: [{ name: 'zombie', x: 12 }]
        });
        const { choice, loop } = await tickOnce(agent);
        assert.notEqual(loop.lastRisk.level, 'high');
        assert.equal(choice, 'explore');
    });

    it('cautious posture treats the same lone mob as riskier', async () => {
        const bold = makeAgent({ time: 6000, posture: 'bold', hostiles: [{ name: 'zombie', x: 12 }] });
        const cautious = makeAgent({ time: 6000, posture: 'cautious', hostiles: [{ name: 'zombie', x: 12 }] });
        const b = await tickOnce(bold);
        const c = await tickOnce(cautious);
        assert.ok(c.loop.lastRisk.score >= b.loop.lastRisk.score);
    });

    it('night with a known bed — sleeps instead of exploring', async () => {
        const agent = makeAgent({ time: 18000, idleMs: 120000, bed: true });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'rest');
        assert.deepEqual(agent.ran, ['autonomy:rest']);
    });

    it('night with bed and dark home — rest outranks maintenance', async () => {
        const agent = makeAgent({
            time: 18000, idleMs: 120000, bed: true, home: true, dark: true,
            slots: [item('torch', 20, 5)]
        });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'rest'); // 0.5 beats maintain_base 0.45
    });

    it('day with a dark home — lights the base', async () => {
        const agent = makeAgent({
            time: 6000, idleMs: 120000, home: true, dark: true,
            slots: [item('torch', 20, 5)]
        });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'maintain_base');
    });

    it('dangerous night — sleep is held like any risky need', async () => {
        const agent = makeAgent({
            time: 18000, idleMs: 120000, bed: true,
            hostiles: [{ name: 'zombie', x: 6 }, { name: 'skeleton', x: 0, z: 8 }],
            slots: [item('bread', 9, 5)]
        });
        const { choice, loop } = await tickOnce(agent);
        assert.equal(loop.lastRisk.level, 'high');
        assert.equal(choice, null);
        const held = loop.history.find(h => h.result?.startsWith('held'));
        assert.ok(held);
        assert.ok(['rest', 'explore'].includes(held.kind), `held should be rest/explore, got ${held.kind}`);
    });
});

describe('survival benchmark: invariants over many ticks', () => {
    it('never runs a risky need while local risk is high', async () => {
        const risky = new Set(['explore', 'farm']);
        for (let night = 0; night < 6; night++) {
            const agent = makeAgent({
                time: 18000, idleMs: 120000,
                hostiles: [{ name: 'zombie', x: 6 }, { name: 'skeleton', x: 0, z: 8 }],
                matureCrops: [1, 2]
            });
            const { loop } = await tickOnce(agent);
            assert.equal(loop.lastRisk.level, 'high');
            const ranKind = agent.ran[0]?.replace('autonomy:', '');
            if (ranKind) assert.ok(!risky.has(ranKind), `ran risky ${ranKind} under high risk`);
        }
    });

    it('safe upkeep always survives dangerous nights', async () => {
        const agent = makeAgent({
            time: 18000, idleMs: 120000,
            hostiles: [{ name: 'zombie', x: 6 }, { name: 'skeleton', x: 0, z: 8 }],
            slots: [item('coal', 9, 4), item('stick', 10, 8), item('bread', 11, 1)]
        });
        const { choice, loop } = await tickOnce(agent);
        assert.equal(loop.lastRisk.level, 'high');
        assert.equal(choice, 'restock_torches');
    });

    it('a broken tool outranks even a full inventory', async () => {
        const slots = [];
        for (let s = 9; s <= 44; s++) slots.push(item('cobblestone', s, 64)); // full
        slots[9] = item('iron_pickaxe', 9, 1, { maxDurability: 250, durabilityUsed: 250 }); // broken
        const agent = makeAgent({ time: 6000, idleMs: 120000, slots });
        const { choice } = await tickOnce(agent);
        assert.equal(choice, 'tool_replace:iron_pickaxe');
    });

    it('configured patrol circuit replaces idle exploration by day', async () => {
        const saved = settings.autonomy.needs.patrol_pois;
        try {
            settings.autonomy.needs.patrol_pois = ['north-tower', 'south-gate'];
            const agent = makeAgent({ time: 6000, idleMs: 120000 });
            const { choice } = await tickOnce(agent);
            assert.equal(choice, 'patrol:2pois');
        } finally {
            settings.autonomy.needs.patrol_pois = saved;
        }
    });

    it('patrol is held at night like exploration (risky need)', async () => {
        const saved = settings.autonomy.needs.patrol_pois;
        try {
            settings.autonomy.needs.patrol_pois = ['north-tower', 'south-gate'];
            const agent = makeAgent({
                time: 18000, idleMs: 120000,
                hostiles: [{ name: 'zombie', x: 6 }, { name: 'skeleton', x: 0, z: 8 }],
                slots: [item('coal', 9, 4), item('stick', 10, 8)]
            });
            const { loop } = await tickOnce(agent);
            assert.equal(loop.lastRisk.level, 'high');
            assert.ok(agent.ran.every(l => !l.includes('patrol')), 'patrol must not run under high risk');
        } finally {
            settings.autonomy.needs.patrol_pois = saved;
        }
    });
});
