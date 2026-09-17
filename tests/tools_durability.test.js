import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isTool, toolCondition, listTools, sparesOf, bestToolForBlock,
    ensureUsableTool, replacementPlan, replaceTool, toolsReport,
    DEFAULT_REPLACE_THRESHOLD
} from '../src/agent/library/durability.js';

function item(name, slot, { used = 0, max = 100, count = 1, type = null } = {}) {
    return {
        name, slot, count, type: type ?? slot,
        maxDurability: max,
        durabilityUsed: used
    };
}

function botWith(items, extra = {}) {
    const slots = [];
    for (const it of items) slots[it.slot] = it;
    return {
        inventory: { slots },
        heldItem: null,
        equipCalls: [],
        equip: async (it, dest) => { },
        ...extra
    };
}

describe('durability classification', () => {
    it('isTool recognizes tool suffixes', () => {
        for (const n of ['wooden_pickaxe', 'iron_axe', 'stone_shovel', 'golden_hoe', 'diamond_sword', 'shears'])
            assert.ok(isTool(n), n);
        for (const n of ['dirt', 'apple', 'oak_planks', null, ''])
            assert.ok(!isTool(n));
    });

    it('toolCondition computes remaining/pct/broken', () => {
        const c = toolCondition(item('iron_pickaxe', 0, { used: 90, max: 250 }));
        assert.equal(c.remaining, 160);
        assert.ok(Math.abs(c.pct - 0.64) < 1e-9);
        assert.equal(c.broken, false);
        const broken = toolCondition(item('stone_axe', 1, { used: 131, max: 131 }));
        assert.equal(broken.remaining, 0);
        assert.equal(broken.broken, true);
        assert.equal(toolCondition({ name: 'dirt' }), null);
        assert.equal(toolCondition(null), null);
    });

    it('listTools reports only tools, sorted by remaining, flagged worn', () => {
        const bot = botWith([
            item('iron_pickaxe', 0, { used: 240, max: 250 }),   // 4% left -> worn
            item('stone_pickaxe', 1, { used: 10, max: 131 }),   // healthy
            item('dirt', 2),                                     // not a tool
            item('diamond_sword', 3, { used: 1500, max: 1561 })
        ]);
        const tools = listTools(bot);
        // sorted by remaining durability: 121 (stone pick), 61 (sword), 10 (iron pick)
        assert.deepEqual(tools.map(t => t.name), ['stone_pickaxe', 'diamond_sword', 'iron_pickaxe']);
        // iron pickaxe (4% left) AND the sword (3.9% left) are below threshold
        const worn = tools.filter(t => t.worn);
        assert.deepEqual(worn.map(t => t.name).sort(), ['diamond_sword', 'iron_pickaxe']);
    });

    it('sparesOf filters by name and living durability', () => {
        const bot = botWith([
            item('stone_pickaxe', 0, { used: 0, max: 131 }),
            item('stone_pickaxe', 1, { used: 131, max: 131 }), // broken
            item('iron_pickaxe', 2, { used: 0, max: 250 })
        ]);
        const spares = sparesOf(bot, 'stone_pickaxe');
        assert.equal(spares.length, 1);
        assert.equal(spares[0].slot, 0);
    });
});

describe('bestToolForBlock / ensureUsableTool', () => {
    const stoneBlock = {
        name: 'stone',
        canHarvest: (type) => [10, 11].includes(type) // slot 10/11 hold qualifying tools
    };

    it('picks the harvestable tool with most remaining durability', () => {
        const bot = botWith([
            item('wooden_pickaxe', 10, { used: 55, max: 60 }),   // 5 left
            item('stone_pickaxe', 11, { used: 10, max: 131 })    // 121 left
        ]);
        const best = bestToolForBlock(bot, stoneBlock);
        assert.equal(best.name, 'stone_pickaxe');
    });

    it('returns null when nothing can harvest', () => {
        const bot = botWith([item('dirt', 0)]);
        assert.equal(bestToolForBlock(bot, stoneBlock), null);
        assert.equal(bestToolForBlock(bot, {}), null);
    });

    it('keeps a healthy held tool', async () => {
        const held = item('stone_pickaxe', 11, { used: 10, max: 131 });
        const bot = botWith([held], { heldItem: held });
        const res = await ensureUsableTool(bot, stoneBlock);
        assert.equal(res.equipped, false);
        assert.equal(res.reason, 'ok');
    });

    it('swaps a worn held tool for the healthiest one', async () => {
        const worn = item('wooden_pickaxe', 10, { used: 58, max: 60 }); // 3% left
        const fresh = item('stone_pickaxe', 11, { used: 0, max: 131 });
        const bot = botWith([worn, fresh], { heldItem: worn });
        let equipped = null;
        bot.equip = async (it) => { equipped = it; };
        const res = await ensureUsableTool(bot, stoneBlock);
        assert.equal(res.equipped, true);
        assert.equal(res.reason, 'swapped-worn');
        assert.equal(equipped.name, 'stone_pickaxe');
    });

    it('reports worn-no-better when the best tool is already held', async () => {
        const worn = item('stone_pickaxe', 11, { used: 128, max: 131 });
        const bot = botWith([worn], { heldItem: worn });
        const res = await ensureUsableTool(bot, stoneBlock);
        assert.equal(res.equipped, false);
        assert.equal(res.reason, 'worn-no-better');
    });

    it('equips a tool when holding nothing that harvests', async () => {
        const tool = item('stone_pickaxe', 11, { used: 5, max: 131 });
        const bot = botWith([tool, item('dirt', 0)], { heldItem: item('dirt', 0) });
        const res = await ensureUsableTool(bot, stoneBlock);
        assert.equal(res.equipped, true);
        assert.equal(res.reason, 'equipped');
    });
});

describe('replacement planning', () => {
    const PICK_RECIPE = [[{ cobblestone: 3, stick: 2 }, { craftedCount: 1 }]];

    it('no_recipe when the provider knows nothing', () => {
        const bot = botWith([]);
        const plan = replacementPlan(bot, 'weird_thing', { getRecipes: () => null });
        assert.equal(plan.status, 'no_recipe');
    });

    it('craftable when bot.recipesFor has a hit', () => {
        const bot = botWith([], { recipesFor: () => [{}] });
        const plan = replacementPlan(bot, 'stone_pickaxe', {
            getRecipes: () => PICK_RECIPE,
            getItemId: () => 123
        });
        assert.equal(plan.status, 'craftable');
    });

    it('missing lists exact deficits', () => {
        const bot = botWith([item('stick', 0, { max: 0, count: 1 })], { recipesFor: () => [] });
        const plan = replacementPlan(bot, 'stone_pickaxe', {
            getRecipes: () => PICK_RECIPE,
            getHave: (b) => ({ stick: 1 })
        });
        assert.equal(plan.status, 'missing');
        assert.deepEqual(plan.missing, { cobblestone: 3, stick: 1 });
    });

    it('craftable when inventory covers the recipe', () => {
        const bot = botWith([], { recipesFor: () => [] });
        const plan = replacementPlan(bot, 'stone_pickaxe', {
            getRecipes: () => PICK_RECIPE,
            getHave: () => ({ cobblestone: 3, stick: 2 })
        });
        assert.equal(plan.status, 'craftable');
    });
});

describe('replaceTool', () => {
    it('prefers the healthiest spare', async () => {
        const spare = item('iron_pickaxe', 4, { used: 10, max: 250 });
        const bot = botWith([spare]);
        let equipped = null;
        bot.equip = async (it) => { equipped = it; };
        const msg = await replaceTool(bot, 'iron_pickaxe', {});
        assert.match(msg, /Equipped best spare iron_pickaxe/);
        assert.equal(equipped.slot, 4);
    });

    it('crafts when no spare exists and materials suffice', async () => {
        const bot = botWith([], { recipesFor: () => [{}] });
        let crafted = null;
        const msg = await replaceTool(bot, 'stone_pickaxe', {
            craftFn: async (b, name, n) => {
                crafted = { name, n };
                b.inventory.slots[9] = item(name, 9, { used: 0, max: 131 }); // fresh tool appears
                return true;
            },
            getRecipes: () => [[{ cobblestone: 3, stick: 2 }, {}]],
            getItemId: () => 123
        });
        assert.match(msg, /Crafted and equipped a fresh stone_pickaxe/);
        assert.deepEqual(crafted, { name: 'stone_pickaxe', n: 1 });
    });

    it('reports missing materials without crafting', async () => {
        const bot = botWith([], { recipesFor: () => [] });
        let crafted = false;
        const msg = await replaceTool(bot, 'stone_pickaxe', {
            craftFn: async () => { crafted = true; return true; },
            getRecipes: () => [[{ cobblestone: 3, stick: 2 }, {}]],
            getHave: () => ({ stick: 2 })
        });
        assert.match(msg, /missing 3x cobblestone/);
        assert.equal(crafted, false);
    });

    it('handles unknown recipes gracefully', async () => {
        const bot = botWith([]);
        const msg = await replaceTool(bot, 'magic_pickaxe', { getRecipes: () => null });
        assert.match(msg, /No crafting recipe known/);
    });
});

describe('toolsReport', () => {
    it('summarizes and flags worn tools with plans', () => {
        const bot = botWith([
            item('iron_pickaxe', 0, { used: 245, max: 250 }),
            item('stone_axe', 1, { used: 1, max: 131 })
        ], { recipesFor: () => [] });
        const report = toolsReport(bot);
        assert.match(report, /TOOLS \(2 in inventory/);
        assert.match(report, /iron_pickaxe .*\(2%\)/);
        assert.match(report, /WORN/);
        assert.match(report, /stone_axe/);
        assert.ok(DEFAULT_REPLACE_THRESHOLD > 0 && DEFAULT_REPLACE_THRESHOLD < 1);
    });

    it('reports empty inventory', () => {
        assert.equal(toolsReport(botWith([])), 'No tools in inventory.');
    });
});
