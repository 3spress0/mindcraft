/**
 * crafting_ops.test.js — crafting tests (GO list). Uses the real
 * minecraft-data registry for recipe math, and a fake bot for the full
 * craftRecipe flow including the craft_verified / craft_short verification.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import settings from '../settings.js';

const VERSION = '1.20.1';
let mc, skills;

before(async () => {
    settings.minecraft_version = VERSION;
    mc = await import('../src/utils/mcdata.js');
    mc.initForVersion(VERSION); // offline init for the pinned version
    skills = await import('../src/agent/library/skills.js');
});

function fakeCraftBot({ planks = 8, craftAdds = true, addFactor = 1 } = {}) {
    const mcData = minecraftData(VERSION);
    const slots = [];
    if (planks > 0) slots.push({ name: 'oak_planks', count: planks, slot: 9 });
    const bot = {
        username: 'SweepCraftBot',
        _logs: [],
        chat: () => {},
        armorManager: { equipAll: () => {} },
        entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
        inventory: { slots },
        recipesFor: (itemId, _a, _n, table) => {
            if (table) return []; // no table recipes in this test
            // mineflayer wraps raw mcdata ids into {id, count} entries, and
            // only offers recipes whose ingredients are in the inventory
            const wrap = (id) => (typeof id === 'number' ? { id, count: 1 } : id);
            const recs = mcData.recipes[itemId];
            if (!Array.isArray(recs)) return [];
            const have = {};
            for (const s of bot.inventory.slots) if (s?.name) have[s.name] = (have[s.name] ?? 0) + s.count;
            const byId = new Map(Object.values(mcData.items).map(i => [i.id, i.name]));
            return recs
                .map(r => ({
                    ...r,
                    inShape: r.inShape?.map(row => row.map(wrap)),
                    ingredients: r.ingredients?.map(wrap)
                }))
                .filter(r => {
                    const cells = [...(r.inShape?.flat() ?? []), ...(r.ingredients ?? [])];
                    return cells.every(c => !c || c.id < 0 || (have[byId.get(c.id)] ?? 0) >= 1);
                });
        },
        craft: async (_recipe, count, _table) => {
            if (!craftAdds) return; // simulate a craft that produces nothing
            // consume planks (2 per craft), add sticks (4 per craft)
            const p = bot.inventory.slots.find(s => s?.name === 'oak_planks');
            if (p) p.count -= 2 * count;
            const sticks = 4 * count * addFactor;
            const existing = bot.inventory.slots.find(s => s?.name === 'stick');
            if (existing) existing.count += sticks;
            else bot.inventory.slots.push({ name: 'stick', count: sticks, slot: 10 });
        }
    };
    return bot;
}

describe('crafting recipe math (real minecraft-data)', () => {
    it('finds the stick recipe and parses its ingredients', () => {
        const recipes = mc.getItemCraftingRecipes('stick');
        assert.ok(recipes.length > 0, 'sticks must have a recipe');
        const stickId = mc.getItemId('stick');
        const raw = minecraftData(VERSION).recipes[stickId][0];
        // mineflayer shape: bare ids become {id, count} entries
        const shaped = {
            result: raw.result,
            inShape: raw.inShape.map(row => row.map(id => ({ id, count: 1 })))
        };
        const ingredients = mc.ingredientsFromPrismarineRecipe(shaped);
        assert.ok(ingredients.oak_planks >= 2, `stick recipe needs planks, got ${JSON.stringify(ingredients)}`);
    });

    it('flags items without recipes', () => {
        assert.equal(mc.getItemCraftingRecipes('definitely_not_an_item')?.length ?? 0, 0);
    });

    it('calculateLimitingResource finds the bottleneck', () => {
        const have = { oak_planks: 8, stick: 2 };
        const need = { oak_planks: 2 };
        const res = mc.calculateLimitingResource(have, need);
        assert.equal(res.num, 4);
        assert.equal(res.limitingResource, 'oak_planks');
        assert.equal(mc.calculateLimitingResource({ a: 0 }, { a: 1 }).num, 0);
    });
});

describe('craftRecipe verification flow', () => {
    it('crafts sticks and verifies the inventory delta (craft_verified)', async () => {
        const bot = fakeCraftBot({ planks: 8 });
        const ok = await skills.craftRecipe(bot, 'stick', 4);
        assert.equal(ok, true);
        const counts = {};
        for (const s of bot.inventory.slots) if (s?.name) counts[s.name] = (counts[s.name] ?? 0) + s.count;
        assert.ok((counts.stick ?? 0) >= 4, `expected >=4 sticks, got ${counts.stick}`);
    });

    it('reports craft_short when the craft produces nothing', async () => {
        const bot = fakeCraftBot({ planks: 8, craftAdds: false });
        const ok = await skills.craftRecipe(bot, 'stick', 4);
        assert.equal(ok, false, 'a craft that adds nothing must not verify');
    });

    it('refuses items without recipes', async () => {
        const bot = fakeCraftBot({});
        const ok = await skills.craftRecipe(bot, 'definitely_not_an_item', 1);
        assert.equal(ok, false);
    });

    it('refuses when ingredients are missing', async () => {
        const bot = fakeCraftBot({ planks: 0 });
        const ok = await skills.craftRecipe(bot, 'stick', 4);
        assert.equal(ok, false);
    });
});
