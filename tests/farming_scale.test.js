/**
 * farming_scale.test.js — base-scale farm loop (GO list: autonomous farming at
 * base scale). The bot doesn't just tend existing crops: when it holds seeds
 * but farmland runs out, it tills new soil near water and plants it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    carriedHoe, waterNear, scanTillable, tillSoil, executeFarming
} from '../src/agent/autonomy/farming.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';

function item(name, slot, count = 1) {
    return { name, slot, count, type: slot, maxDurability: null, durabilityUsed: 0 };
}

/** Mutable fake world: blocks array; tilling flips dirt -> farmland. */
function farmBot({ blocks, slots = [] }) {
    const calls = { tilled: [], planted: [], dug: [] };
    const bot = {
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0) },
        inventory: { slots },
        game: { gameMode: 'survival' },
        modes: { isOn: (m) => m === 'cheat' }, // goToPosition takes the teleport path
        chat: () => {},
        _personality: {},
        findBlocks: () => blocks.map(b => b.position),
        blockAt: (pos) => blocks.find(b =>
            b.position.x === pos.x && b.position.y === pos.y && b.position.z === pos.z
        ) ?? { name: 'air', position: pos },
        equip: async () => {},
        dig: async (block) => { calls.dug.push(block.name); },
        placeBlock: async (block) => { calls.planted.push(block.position); },
        activateBlock: async (block) => {
            block.name = 'farmland'; // the server would flip this server-side
            calls.tilled.push(block.position);
        }
    };
    return { bot, calls };
}

const b = (name, x, y = 64, z = 0, props = {}) => ({
    name, position: new Vec3(x, y, z), getProperty: (k) => props[k] ?? null
});

describe('base-scale farm growth', () => {
    it('carriedHoe finds any hoe tier', () => {
        const { bot } = farmBot({ blocks: [], slots: [item('stone_hoe', 5)] });
        assert.equal(carriedHoe(bot), 'stone_hoe');
        const empty = farmBot({ blocks: [] });
        assert.equal(carriedHoe(empty.bot), null);
    });

    it('waterNear respects the 4-block hydration rule', () => {
        const withWater = farmBot({ blocks: [b('water', 3, 64, 0)] });
        assert.equal(waterNear(withWater.bot, { x: 0, y: 64, z: 0 }), true);
        const far = farmBot({ blocks: [b('water', 5, 64, 0)] });
        assert.equal(waterNear(far.bot, { x: 0, y: 64, z: 0 }), false);
        const diagonal = farmBot({ blocks: [b('water', 3, 64, 3)] });
        assert.equal(waterNear(diagonal.bot, { x: 0, y: 64, z: 0 }), true);
    });

    it('scanTillable finds dirt with air above and water in range', () => {
        const { bot } = farmBot({
            blocks: [
                b('dirt', 1),            // tilled: water at 3,0
                b('grass_block', 2),     // tilled
                b('dirt', 1, 64, 8),     // no water nearby
                b('dirt', -1, 63, 0),    // covered by the dirt above? no — different column
                b('dirt', 4, 64, 0),     // water sits ON this column's water check is fine
                b('water', 3, 64, 0)
            ]
        });
        // block above (1,65,0) is air (unregistered) -> tillable
        const spots = scanTillable(bot, { radius: 16 });
        const keys = spots.map(s => `${s.position.x},${s.position.z}`).sort();
        assert.ok(keys.includes('1,0'));
        assert.ok(keys.includes('2,0'));
        assert.ok(!keys.includes('1,8'), 'dry soil must not be tilled');
    });

    it('scanTillable skips covered soil', () => {
        const { bot } = farmBot({
            blocks: [b('dirt', 1), b('stone', 1, 65, 0), b('water', 3, 64, 0)]
        });
        assert.equal(scanTillable(bot, { radius: 16 }).length, 0);
    });

    it('tillSoil needs a hoe and respects maxTill', async () => {
        const blocks = [b('dirt', 1), b('dirt', 2), b('dirt', -1, 64, 1), b('water', 4, 64, 0)];
        const withHoe = farmBot({ blocks, slots: [item('iron_hoe', 5)] });
        const tilled = await tillSoil(withHoe.bot, { maxTill: 2 });
        assert.equal(tilled, 2, 'bounded by maxTill');
        const noHoe = farmBot({ blocks: [b('dirt', 1), b('water', 3, 64, 0)] });
        assert.equal(await tillSoil(noHoe.bot, {}), 0);
    });

    it('executor expands the farm when seeds remain but farmland ran out', async () => {
        const blocks = [
            b('dirt', 1), b('dirt', 2), b('water', 4, 64, 0)
        ];
        const { bot, calls } = farmBot({
            blocks,
            slots: [item('iron_hoe', 5), item('wheat_seeds', 6, 4)]
        });
        const msg = await executeFarming({ bot }, null, { farm_radius: 16, max_till: 2 });
        assert.match(msg, /expanded 2 plot\(s\)/);
        assert.match(msg, /planted \d+ seed\(s\)/);
        assert.equal(calls.tilled.length, 2);
        assert.ok(calls.planted.length > 0, 'planted into the freshly tilled plots');
    });

    it('executor refuses to expand when farm_expand is off', async () => {
        const blocks = [b('dirt', 1), b('water', 3, 64, 0)];
        const { bot } = farmBot({
            blocks,
            slots: [item('iron_hoe', 5), item('wheat_seeds', 6, 4)]
        });
        const msg = await executeFarming({ bot }, null, { farm_expand: false });
        assert.equal(msg, 'farm: nothing ready to tend');
    });

    it('harvest still takes priority over expansion', async () => {
        const blocks = [
            b('wheat', 1, 64, 0, { age: 7 }),
            b('dirt', 2), b('water', 4, 64, 0)
        ];
        const { bot, calls } = farmBot({
            blocks,
            slots: [item('iron_hoe', 5), item('wheat_seeds', 6, 4)]
        });
        const msg = await executeFarming({ bot }, null, {});
        assert.match(msg, /harvested 1 mature crop/);
        assert.equal(calls.dug.length, 1);
        assert.equal(calls.tilled.length, 0);
    });
});

describe('farm expansion need', () => {
    it('fires when seeds exist, farmland is gone, and a hoe is carried', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 20, idleForMs: 120000, isNight: false,
            inventoryCounts: { wheat_seeds: 4 }, foodCount: 2,
            farm: { mature: 0, total: 0, seeds: 4, farmland: 0, canTill: true }
        }, {});
        const farm = needs.find(n => n.kind === 'farm');
        assert.ok(farm, 'expansion counts as farm work');
        assert.match(farm.detail, /till new plots/);
    });

    it('does not fire without a hoe', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 20, idleForMs: 120000, isNight: false,
            inventoryCounts: { wheat_seeds: 4 }, foodCount: 2,
            farm: { mature: 0, total: 0, seeds: 4, farmland: 0, canTill: false }
        }, {});
        assert.ok(!needs.some(n => n.kind === 'farm'));
    });
});
