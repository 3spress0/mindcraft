import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateNeeds, countFreeSlots, isNightTime, autonomyDefaults, NEED_KINDS
} from '../src/agent/autonomy/needs.js';
import {
    AutonomyLoop, getAutonomyConfig, snapshotNeeds
} from '../src/agent/autonomy/task_loop.js';
import { EXECUTORS, executeToolReplacement } from '../src/agent/autonomy/executors.js';

function tool(name, pct, broken = false) {
    return { name, pct, remaining: Math.round(pct * 100), maxDurability: 100, broken };
}

describe('autonomy needs evaluation', () => {
    it('returns no needs for a healthy, busy bot', () => {
        const needs = evaluateNeeds({ tools: [tool('iron_pickaxe', 0.9)], freeSlots: 20, idleForMs: 1000 }, {});
        assert.equal(needs.length, 0);
    });

    it('broken tool outranks worn tool and exploration', () => {
        const needs = evaluateNeeds({
            tools: [tool('stone_axe', 0.1), tool('iron_pickaxe', 0.0, true)],
            freeSlots: 20,
            idleForMs: 120000
        }, {});
        assert.equal(needs[0].kind, 'tool_replace');
        assert.equal(needs[0].detail, 'iron_pickaxe');
        assert.equal(needs[0].urgency, 0.95);
        assert.ok(needs.some(n => n.kind === 'explore'));
    });

    it('inventory_full is actionable (unload executor exists)', () => {
        const needs = evaluateNeeds({ tools: [], freeSlots: 1, idleForMs: 0 }, {});
        const inv = needs.find(n => n.kind === 'inventory_full');
        assert.ok(inv);
        assert.equal(inv.advisory, false);
    });

    it('explore needs idle time and no pending resume', () => {
        const idleCfg = { explore_when_idle: true, explore_idle_s: 60 };
        assert.equal(evaluateNeeds({ idleForMs: 30000 }, idleCfg).filter(n => n.kind === 'explore').length, 0);
        assert.equal(evaluateNeeds({ idleForMs: 70000 }, idleCfg).filter(n => n.kind === 'explore').length, 1);
        assert.equal(evaluateNeeds({ idleForMs: 70000, hasPendingResume: true }, idleCfg).filter(n => n.kind === 'explore').length, 0);
    });

    it('night dampens exploration urgency', () => {
        const day = evaluateNeeds({ idleForMs: 70000, isNight: false }, {});
        const night = evaluateNeeds({ idleForMs: 70000, isNight: true }, {});
        assert.ok(day.find(n => n.kind === 'explore').urgency > night.find(n => n.kind === 'explore').urgency);
    });

    it('explore can be disabled', () => {
        const needs = evaluateNeeds({ idleForMs: 999999 }, { explore_when_idle: false });
        assert.equal(needs.filter(n => n.kind === 'explore').length, 0);
    });

    it('helpers behave', () => {
        assert.ok(NEED_KINDS.includes('tool_replace'));
        assert.ok(autonomyDefaults().tool_replace_threshold > 0);
        const slots = new Array(46).fill(null);
        slots[0] = {}; // crafting grid
        slots[36] = {}; // hotbar occupied
        assert.equal(countFreeSlots({ inventory: { slots } }), 35); // 36 slots minus 1 hotbar item
        assert.equal(countFreeSlots({}), 0);
        assert.equal(isNightTime({ time: { timeOfDay: 14000 } }), true);
        assert.equal(isNightTime({ time: { timeOfDay: 6000 } }), false);
        assert.equal(isNightTime({}), false);
    });
});

function fakeAgent(over = {}) {
    const ran = [];
    return {
        ran,
        bot: { inventory: { slots: new Array(46).fill(null) }, time: { timeOfDay: 6000 } },
        isIdle: () => true,
        isHandlingMessage: () => false,
        idleForMs: () => 0,
        actions: {
            runAction: async (label, fn, opts) => {
                ran.push(label);
                await fn();
                return { interrupted: false };
            }
        },
        ...over
    };
}

describe('autonomy task loop', () => {
    const stubExecutors = {
        tool_replace: async (agent, need) => `replaced ${need.detail}`,
        explore: async () => 'explored'
    };

    function loopFor(agent, now = { t: 0 }) {
        return new AutonomyLoop(agent, { now: () => now.t, executors: stubExecutors });
    }

    it('executes the most urgent need through runAction', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        const now = { t: 1000 };
        const loop = loopFor(agent, now);
        await loop.tick();
        assert.deepEqual(agent.ran, ['autonomy:explore']);
        assert.equal(loop.history.length, 1);
        assert.equal(loop.history[0].kind, 'explore');
        assert.match(loop.history[0].result, /explored/);
    });

    it('prefers tool replacement over exploration', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        agent.bot.inventory.slots[10] = { name: 'iron_pickaxe', slot: 10, count: 1, maxDurability: 100, durabilityUsed: 99 };
        const loop = loopFor(agent, { t: 0 });
        await loop.tick();
        assert.deepEqual(agent.ran, ['autonomy:tool_replace']);
        assert.equal(loop.history[0].detail, 'iron_pickaxe');
    });

    it('respects the cooldown between runs', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        const now = { t: 0 };
        const loop = loopFor(agent, now);
        await loop.tick();
        now.t += 1000; // 1s later: still inside cooldown
        await loop.tick();
        assert.equal(agent.ran.length, 1, 'no second run during cooldown');
        now.t += 120000; // well past any cooldown
        await loop.tick();
        assert.equal(agent.ran.length, 2);
    });

    it('does nothing when disabled, busy, or conversing', async () => {
        const busy = fakeAgent({ isIdle: () => false, idleForMs: () => 90000 });
        await loopFor(busy).tick();
        assert.equal(busy.ran.length, 0);

        const handling = fakeAgent({ isHandlingMessage: () => true, idleForMs: () => 90000 });
        await loopFor(handling).tick();
        assert.equal(handling.ran.length, 0);

        const off = fakeAgent({ idleForMs: () => 90000 });
        const loop = loopFor(off);
        loop.setRuntimeEnabled(false);
        await loop.tick();
        assert.equal(off.ran.length, 0);
        assert.equal(loop.enabled, false);
    });

    it('skips self-prompting agents', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000, self_prompter: { isActive: () => true } });
        await loopFor(agent).tick();
        assert.equal(agent.ran.length, 0);
    });

    it('needs without executors schedule cooldown without running', async () => {
        const agent = fakeAgent({ idleForMs: () => 0 });
        agent.bot.inventory.slots = agent.bot.inventory.slots.fill({}); // zero free slots -> inventory_full
        const loop = loopFor(agent, { t: 0 }); // stub executors lack inventory_full
        await loop.tick();
        assert.equal(agent.ran.length, 0);
        assert.equal(loop.history.length, 0);
    });

    it('records interrupted results', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        agent.actions.runAction = async (label, fn) => { await fn(); return { interrupted: true }; };
        const loop = loopFor(agent, { t: 0 });
        await loop.tick();
        assert.match(loop.history[0].result, /\[interrupted\]/);
    });

    it('bounds history', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        const now = { t: 0 };
        const loop = loopFor(agent, now);
        for (let i = 0; i < 25; i++) {
            now.t += 120000;
            await loop.tick();
        }
        assert.ok(loop.history.length <= getAutonomyConfig().history_limit);
        assert.ok(loop.history.length >= 10);
    });

    it('summarize reports state and needs', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        const loop = loopFor(agent, { t: 0 });
        await loop.tick();
        const summary = loop.summarize();
        assert.match(summary, /AUTONOMY \(ON\)/);
        assert.match(summary, /Last run: explore/);
        assert.match(summary, /Recent history:/);
    });

    it('executor errors are contained', async () => {
        const agent = fakeAgent({ idleForMs: () => 90000 });
        const bad = { explore: async () => { throw new Error('boom'); } };
        const loop = new AutonomyLoop(agent, { now: () => 0, executors: bad });
        await loop.tick(); // must not throw
        assert.equal(agent.ran.length, 1);
        assert.equal(loop.history[0].result, 'executor error: boom');
    });
});

describe('autonomy config', () => {
    it('reads sane defaults from settings', () => {
        const cfg = getAutonomyConfig();
        assert.equal(typeof cfg.enabled, 'boolean');
        assert.ok(cfg.cooldown_s[0] >= 5 && cfg.cooldown_s[1] >= cfg.cooldown_s[0]);
        assert.ok(cfg.action_timeout_s >= 30);
        assert.ok(cfg.needs.tool_replace_threshold > 0 && cfg.needs.tool_replace_threshold < 1);
    });
});

describe('real executors', () => {
    function item(name, slot, used, max) {
        return { name, slot, count: 1, type: slot, maxDurability: max, durabilityUsed: used };
    }

    it('executeToolReplacement equips a spare', async () => {
        const spare = item('iron_pickaxe', 4, 10, 250);
        const bot = {
            inventory: { slots: (() => { const s = []; s[4] = spare; return s; })() },
            equip: async () => {}
        };
        const msg = await executeToolReplacement({ bot }, { detail: 'iron_pickaxe' });
        assert.match(msg, /tool_replace: Equipped best spare iron_pickaxe/);
    });

    it('executeToolReplacement reports missing tool name', async () => {
        const msg = await executeToolReplacement({ bot: {} }, {});
        assert.match(msg, /no tool specified/);
    });

    it('EXECUTORS map covers all actionable needs', () => {
        assert.ok(EXECUTORS.tool_replace);
        assert.ok(EXECUTORS.explore);
        assert.ok(EXECUTORS.inventory_full);
        assert.ok(EXECUTORS.restock_torches);
        assert.ok(EXECUTORS.restock_food);
    });

    it('snapshotNeeds handles missing bot pieces', () => {
        const snap = snapshotNeeds({ bot: {} }, getAutonomyConfig());
        assert.equal(snap.freeSlots, 0);
        assert.deepEqual(snap.tools, []);
        assert.equal(snap.isNight, false);
    });
});
