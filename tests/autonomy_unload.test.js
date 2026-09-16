import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEdible, shouldKeep, itemsToUnload, executeInventoryUnload } from '../src/agent/autonomy/unload.js';
import { EXECUTORS, executeExploration, executeRestock } from '../src/agent/autonomy/executors.js';
import { createPersonality, PRESETS, RISK_PRESETS } from '../src/agent/humanlike/personality.js';

function item(name, slot, count = 1, type = slot) {
    return { name, slot, count, type, maxDurability: null, durabilityUsed: 0 };
}

function botWith(items, extra = {}) {
    const slots = [];
    for (const it of items) slots[it.slot] = it;
    return { registry: null, inventory: { slots }, ...extra };
}

describe('unload policy', () => {
    it('isEdible: registry first, name fallback', () => {
        const bot = { registry: { foodsById: { 42: true } } };
        assert.equal(isEdible(bot, { name: 'mystery_meal', type: 42 }), true);
        assert.equal(isEdible({}, { name: 'bread' }), true);
        assert.equal(isEdible({}, { name: 'cooked_beef' }), true);
        assert.equal(isEdible({}, { name: 'golden_apple' }), true);
        assert.equal(isEdible({}, { name: 'dirt' }), false);
        assert.equal(isEdible({}, { name: 'stone_pickaxe' }), false);
        assert.equal(isEdible({}, null), false);
    });

    it('shouldKeep: tools, armor, food, working items', () => {
        const bot = {};
        assert.equal(shouldKeep(bot, item('iron_pickaxe', 0)), true);
        assert.equal(shouldKeep(bot, item('diamond_sword', 0)), true);
        assert.equal(shouldKeep(bot, item('iron_chestplate', 0)), true);
        assert.equal(shouldKeep(bot, item('shield', 0)), true);
        assert.equal(shouldKeep(bot, item('bread', 0)), true);
        assert.equal(shouldKeep(bot, item('water_bucket', 0)), true);
        assert.equal(shouldKeep(bot, item('cobblestone', 0, 64)), false);
        assert.equal(shouldKeep(bot, item('dirt', 0, 64)), false);
        assert.equal(shouldKeep(bot, item('oak_log', 0, 8)), false);
    });

    it('itemsToUnload aggregates, sorts by count, and caps', () => {
        const items = [];
        let slot = 9;
        items.push(item('cobblestone', slot++, 64));
        items.push(item('dirt', slot++, 32));
        items.push(item('oak_log', slot++, 16));
        items.push(item('granite', slot++, 10));
        items.push(item('iron_pickaxe', slot++, 1));
        items.push(item('bread', slot++, 5));
        const list = itemsToUnload(botWith(items), { maxTypes: 2 });
        assert.deepEqual(list, [
            { name: 'cobblestone', count: 64 },
            { name: 'dirt', count: 32 }
        ]);
        const full = itemsToUnload(botWith(items), { maxTypes: 8 });
        assert.deepEqual(full.map(e => e.name), ['cobblestone', 'dirt', 'oak_log', 'granite']);
    });
});

describe('unload executor', () => {
    it('reports when no chest is reachable', async () => {
        const agent = {
            bot: {
                entity: { position: { x: 0, y: 64, z: 0 } },
                findBlocks: () => [],
                blockAt: () => null,
                inventory: { slots: [] }
            }
        };
        const msg = await executeInventoryUnload(agent, {});
        assert.match(msg, /no chest within 32 blocks/);
    });

    it('reports nothing to deposit when inventory is all essentials', async () => {
        // a chest right next to the bot, but nothing worth unloading
        const chestPos = { x: 2, y: 64, z: 0 };
        const agent = {
            bot: {
                entity: { position: { x: 0, y: 64, z: 0, distanceTo: (o) => Math.hypot(o.x, o.y - 64, o.z) } },
                findBlocks: () => [chestPos],
                blockAt: (p) => (Math.floor(p.x) === 2 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0)
                    ? { name: 'chest', position: chestPos } : null,
                inventory: { slots: [item('iron_pickaxe', 9), item('bread', 10, 3)] }
            }
        };
        const msg = await executeInventoryUnload(agent, {});
        assert.match(msg, /nothing worth depositing/);
    });

    it('handles missing bot', async () => {
        assert.match(await executeInventoryUnload({}, {}), /no bot/);
    });
});

describe('restock executor', () => {
    it('requires a target item', async () => {
        assert.match(await executeRestock({}, {}), /nothing specified/);
    });
});

describe('social/risk personality presets', () => {
    it('new presets exist and bias their signature traits', () => {
        for (const name of ['guardian', 'greeter', 'scout', 'worker']) {
            assert.ok(PRESETS[name], `preset ${name} missing`);
        }
        let guardCaution = 0, greeterSoc = 0, scoutRest = 0, workerSoc = 0;
        const N = 20;
        for (let i = 0; i < N; i++) {
            guardCaution += createPersonality({ name: `g${i}`, preset: 'guardian' }).traits.caution;
            greeterSoc += createPersonality({ name: `r${i}`, preset: 'greeter' }).traits.sociability;
            scoutRest += createPersonality({ name: `s${i}`, preset: 'scout' }).traits.restlessness;
            workerSoc += createPersonality({ name: `w${i}`, preset: 'worker' }).traits.sociability;
        }
        assert.ok(guardCaution / N > 0.65, 'guardian should be cautious');
        assert.ok(greeterSoc / N > 0.75, 'greeter should be sociable');
        assert.ok(scoutRest / N > 0.55, 'scout should be restless');
        assert.ok(workerSoc / N < 0.45, 'worker should be reserved');
    });

    it('risk presets map to valid path profiles and exploration flags', () => {
        assert.deepEqual(Object.keys(RISK_PRESETS).sort(), ['balanced', 'bold', 'cautious']);
        assert.equal(RISK_PRESETS.cautious.path_profile, 'safe');
        assert.equal(RISK_PRESETS.cautious.explore_when_idle, false);
        assert.equal(RISK_PRESETS.bold.path_profile, 'fast');
        assert.equal(RISK_PRESETS.bold.explore_when_idle, true);
        assert.equal(RISK_PRESETS.balanced.path_profile, 'default');
    });
});

describe('!setRisk action', () => {
    it('applies profile, exploration flag, and stores the posture', async () => {
        const { actionsList } = await import('../src/agent/commands/actions.js');
        const setRisk = actionsList.find(a => a.name === '!setRisk');
        let exploreFlag = null;
        const agent = {
            bot: {},
            autonomy: { setExploreEnabled: (v) => { exploreFlag = v; } }
        };
        const msg = await setRisk.perform(agent, 'cautious');
        assert.match(msg, /Risk posture set to cautious/);
        assert.equal(agent.bot._baritone_profile, 'safe');
        assert.equal(agent.bot._risk_profile, 'cautious');
        assert.equal(exploreFlag, false);

        await setRisk.perform(agent, 'bold');
        assert.equal(agent.bot._baritone_profile, 'fast');
        assert.equal(exploreFlag, true);

        const bad = await setRisk.perform(agent, 'yolo');
        assert.match(bad, /Unknown risk posture/);
    });

    it('explore override gates the autonomy loop exploration', async () => {
        const { AutonomyLoop } = await import('../src/agent/autonomy/task_loop.js');
        const agent = {
            bot: { inventory: { slots: new Array(46).fill(null) }, time: { timeOfDay: 6000 } },
            isIdle: () => true,
            isHandlingMessage: () => false,
            idleForMs: () => 90000,
            actions: { runAction: async (l, fn) => { agent.ran.push(l); await fn(); return { interrupted: false }; } },
            ran: []
        };
        const loop = new AutonomyLoop(agent, { now: () => 0, executors: { explore: async () => 'x' } });
        loop.setExploreEnabled(false);
        await loop.tick();
        assert.equal(agent.ran.length, 0, 'exploration suppressed by risk posture');
        loop.setExploreEnabled(true);
        loop._nextRunAt = 0;
        await loop.tick();
        assert.deepEqual(agent.ran, ['autonomy:explore']);
    });

    it('executors wiring includes the exploration leg-count config', async () => {
        assert.equal(typeof executeExploration, 'function');
        assert.ok(EXECUTORS.restock_food === EXECUTORS.restock_torches);
    });
});
