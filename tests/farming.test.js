import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { CROPS, cropAge, scanCrops, scanFarmland, seedToCrop, availableSeeds, executeFarming } from '../src/agent/autonomy/farming.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';
import { EXECUTORS } from '../src/agent/autonomy/executors.js';

function cropBlock(name, age, x = 0, y = 64, z = 0) {
    return {
        name,
        position: new Vec3(x, y, z),
        getProperty: (k) => (k === 'age' ? age : null)
    };
}

function item(name, slot, count = 1, type = slot) {
    return { name, slot, count, type, maxDurability: null, durabilityUsed: 0 };
}

function botWithBlocks(blocks, slots = []) {
    // findBlocks returns the positions of whatever blocks we registered
    return {
        registry: null,
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0) },
        inventory: { slots },
        findBlocks: () => blocks.map(b => b.position),
        blockAt: (pos) => blocks.find(b => b.position.x === pos.x && b.position.y === pos.y && b.position.z === pos.z) ?? { name: 'air', position: pos }
    };
}

describe('crop maturity detection', () => {
    it('reads age via getProperty', () => {
        assert.equal(cropAge(cropBlock('wheat', 3)), 3);
        assert.equal(cropAge(cropBlock('wheat', 7)), 7);
    });

    it('falls back to properties object', () => {
        const b = { properties: { age: 5 } };
        assert.equal(cropAge(b), 5);
    });

    it('returns null when unreadable', () => {
        assert.equal(cropAge({}), null);
        assert.equal(cropAge(null), null);
        assert.equal(cropAge({ getProperty: () => { throw new Error('x'); } }), null);
    });

    it('knows each crop\'s maturity threshold', () => {
        assert.equal(CROPS.wheat.maxAge, 7);
        assert.equal(CROPS.beetroots.maxAge, 3);
        assert.equal(CROPS.carrots.seed, 'carrot');
        assert.equal(CROPS.potatoes.yield, 'potato');
    });
});

describe('scanCrops', () => {
    it('counts total and mature crops', () => {
        const bot = botWithBlocks([
            cropBlock('wheat', 7, 1, 64, 0),   // mature
            cropBlock('wheat', 3, 2, 64, 0),   // growing
            cropBlock('carrots', 7, 3, 64, 0), // mature
            cropBlock('beetroots', 3, 4, 64, 0), // mature (maxAge 3)
            cropBlock('beetroots', 1, 5, 64, 0), // growing
        ]);
        const scan = scanCrops(bot, { radius: 16 });
        assert.equal(scan.total, 5);
        assert.equal(scan.mature, 3);
        assert.equal(scan.crops.filter(c => c.mature).length, 3);
    });

    it('ignores non-crop blocks', () => {
        const bot = botWithBlocks([cropBlock('wheat', 7), { name: 'stone', position: new Vec3(9, 64, 0) }]);
        const scan = scanCrops(bot, { radius: 16 });
        assert.equal(scan.total, 1);
        assert.equal(scan.mature, 1);
    });

    it('handles a broken findBlocks gracefully', () => {
        const bot = { findBlocks: () => { throw new Error('boom'); }, blockAt: () => null };
        const scan = scanCrops(bot, { radius: 16 });
        assert.deepEqual(scan, { total: 0, mature: 0, crops: [] });
    });
});

describe('scanFarmland', () => {
    it('returns tilled soil with air above', () => {
        const farm = { name: 'farmland', position: new Vec3(1, 63, 0) };
        // blockAt must return air above the farmland
        const bot = {
            findBlocks: () => [farm.position],
            blockAt: (pos) => (pos.y === 63 && pos.x === 1 ? farm : { name: 'air', position: pos })
        };
        const spots = scanFarmland(bot, { radius: 16 });
        assert.equal(spots.length, 1);
        assert.equal(spots[0].position.x, 1);
    });

    it('skips farmland already occupied', () => {
        const farm = { name: 'farmland', position: new Vec3(1, 63, 0) };
        const bot = {
            findBlocks: () => [farm.position],
            blockAt: (pos) => (pos.y === 63 ? farm : { name: 'wheat', position: pos })
        };
        assert.equal(scanFarmland(bot, { radius: 16 }).length, 0);
    });
});

describe('seed helpers', () => {
    it('seedToCrop maps seed item to crop', () => {
        assert.equal(seedToCrop('wheat_seeds').block, 'wheat');
        assert.equal(seedToCrop('beetroot_seeds').block, 'beetroots');
        assert.equal(seedToCrop('carrot').block, 'carrots');
        assert.equal(seedToCrop('dirt'), null);
    });

    it('availableSeeds lists carried seeds with counts', () => {
        const bot = { registry: null, inventory: { slots: [item('wheat_seeds', 9, 5), item('carrot', 10, 2), item('dirt', 11, 64)] } };
        const seeds = availableSeeds(bot);
        assert.deepEqual(seeds.map(s => s.seed).sort(), ['carrot', 'wheat_seeds']);
        const wheat = seeds.find(s => s.seed === 'wheat_seeds');
        assert.equal(wheat.count, 5);
    });
});

describe('farming need wiring', () => {
    it('emits a farm need when food is low and crops are ready', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, foodCount: 0,
            inventoryCounts: {}, // no wheat for bread
            farm: { mature: 4, total: 6, seeds: 0, farmland: 0 }
        }, {});
        const farm = needs.find(n => n.kind === 'farm');
        assert.ok(farm, 'farm need expected');
        assert.match(farm.detail, /harvest 4 mature/);
    });

    it('emits a plant need when only seeds + farmland exist', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, foodCount: 0,
            inventoryCounts: {},
            farm: { mature: 0, total: 0, seeds: 6, farmland: 4 }
        }, {});
        const farm = needs.find(n => n.kind === 'farm');
        assert.ok(farm);
        assert.match(farm.detail, /plant seeds/);
    });

    it('prefers restock_food (bread) over farming when wheat is available', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, foodCount: 0,
            inventoryCounts: { wheat: 3 },
            farm: { mature: 4, total: 4, seeds: 0, farmland: 0 }
        }, {});
        assert.ok(needs.some(n => n.kind === 'restock_food'));
        assert.ok(!needs.some(n => n.kind === 'farm'), 'bread takes priority over harvesting');
    });

    it('no farm need when food is sufficient', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, foodCount: 10,
            inventoryCounts: {},
            farm: { mature: 4, total: 4, seeds: 0, farmland: 0 }
        }, {});
        assert.ok(!needs.some(n => n.kind === 'farm'));
    });
});

describe('executeFarming', () => {
    it('requires a bot', async () => {
        assert.match(await executeFarming({}, {}), /no bot/);
    });

    it('reports nothing to tend when no crops or seeds', async () => {
        const bot = botWithBlocks([], []);
        const agent = { bot };
        const msg = await executeFarming(agent, {}, {});
        assert.match(msg, /nothing ready to tend/);
    });

    it('is wired into EXECUTORS', () => {
        assert.equal(typeof EXECUTORS.farm, 'function');
    });
});
