/**
 * husbandry.test.js — animal feeding & breeding (GO list: Farming > animal
 * feeding / breeding).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    BREEDABLES, isBaby, scanAnimals, planBreeding, executeBreeding, executeHusbandry
} from '../src/agent/autonomy/husbandry.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';
import { RISKY_NEEDS } from '../src/agent/autonomy/risk.js';
import { RETURN_HOME_KINDS } from '../src/agent/autonomy/task_loop.js';

function item(name, slot, count = 1) {
    return { name, slot, count, type: slot, maxDurability: null, durabilityUsed: 0 };
}

function animal(name, x, z, { baby = false, id = `${name}-${x}` } = {}) {
    return {
        id, name,
        type: 'mob',
        position: new Vec3(x, 64, z),
        metadata: baby ? { 16: true } : { 16: false }
    };
}

function breedBot({ entities = {}, slots = [] }) {
    const calls = { activated: [] };
    const bot = {
        interrupt_code: null,
        entity: { position: new Vec3(0, 64, 0) },
        entities,
        inventory: { slots },
        game: { gameMode: 'survival' },
        modes: { isOn: (m) => m === 'cheat' },
        chat: () => {},
        _personality: {},
        equip: async () => {},
        activateEntity: async (e) => { calls.activated.push(e.id); }
    };
    return { bot, calls };
}

describe('breedable knowledge', () => {
    it('covers the classic farm animals with their foods', () => {
        assert.deepEqual(BREEDABLES.cow.foods, ['wheat']);
        assert.deepEqual(BREEDABLES.pig.foods, ['carrot']);
        assert.ok(BREEDABLES.chicken.foods.includes('wheat_seeds'));
        assert.ok(BREEDABLES.mooshroom);
    });

    it('reads the baby flag defensively', () => {
        assert.equal(isBaby(animal('cow', 1, 0, { baby: true })), true);
        assert.equal(isBaby(animal('cow', 1, 0)), false);
        assert.equal(isBaby({ name: 'cow' }), false, 'unreadable metadata -> assumed adult');
    });
});

describe('scanAnimals', () => {
    it('finds adult breedables, skips babies and strangers, sorted by distance', () => {
        const { bot } = breedBot({
            entities: {
                a: animal('cow', 3, 0),
                b: animal('cow', 1, 0),
                c: animal('cow', 2, 0, { baby: true }),
                d: animal('zombie', 4, 0),
                e: animal('sheep', 40, 0) // out of range
            }
        });
        const scan = scanAnimals(bot, { radius: 16 });
        assert.deepEqual(scan.map(s => s.entity.id), ['cow-1', 'cow-3'], 'adults only, nearest first');
    });
});

describe('planBreeding', () => {
    it('pairs animals against carried food', () => {
        const { bot } = breedBot({
            entities: { a: animal('cow', 1, 0), b: animal('cow', 2, 0), c: animal('cow', 3, 0) },
            slots: [item('wheat', 5, 4)]
        });
        const plans = planBreeding(bot, {});
        assert.equal(plans.length, 1);
        assert.equal(plans[0].species, 'cow');
        assert.equal(plans[0].food, 'wheat');
        assert.equal(plans[0].pairs, 1, '3 cows -> 1 pair; 4 wheat allows 2 but animals cap it');
    });

    it('picks the best food and orders plans by payoff', () => {
        const { bot } = breedBot({
            entities: {
                a: animal('chicken', 1, 0), b: animal('chicken', 2, 0),
                c: animal('chicken', 3, 0), d: animal('chicken', 4, 0),
                e: animal('pig', 5, 0), f: animal('pig', 6, 0)
            },
            slots: [item('wheat_seeds', 5, 4), item('carrot', 6, 2)]
        });
        const plans = planBreeding(bot, {});
        assert.deepEqual(plans.map(p => `${p.species}:${p.pairs}`), ['chicken:2', 'pig:1']);
    });

    it('needs at least two adults and two food', () => {
        const lonely = breedBot({
            entities: { a: animal('cow', 1, 0) },
            slots: [item('wheat', 5, 4)]
        });
        assert.equal(planBreeding(lonely.bot, {}).length, 0);
        const hungry = breedBot({
            entities: { a: animal('cow', 1, 0), b: animal('cow', 2, 0) },
            slots: [item('wheat', 5, 1)]
        });
        assert.equal(planBreeding(hungry.bot, {}).length, 0);
    });
});

describe('executeBreeding', () => {
    it('feeds pairs of animals, bounded by maxPairs', async () => {
        const { bot, calls } = breedBot({
            entities: {
                a: animal('cow', 1, 0), b: animal('cow', 2, 0),
                c: animal('cow', 3, 0), d: animal('cow', 4, 0)
            },
            slots: [item('wheat', 5, 8)]
        });
        const bred = await executeBreeding(bot, { maxPairs: 1 });
        assert.equal(bred, 1);
        assert.deepEqual(calls.activated, ['cow-1', 'cow-2'], 'fed the nearest pair only');
    });

    it('stops cleanly on interruption', async () => {
        const { bot, calls } = breedBot({
            entities: { a: animal('cow', 1, 0), b: animal('cow', 2, 0) },
            slots: [item('wheat', 5, 4)]
        });
        bot.interrupt_code = 'chat';
        assert.equal(await executeBreeding(bot, {}), 0);
        assert.equal(calls.activated.length, 0);
    });

    it('survives an activation failure and keeps going', async () => {
        const { bot, calls } = breedBot({
            entities: {
                a: animal('cow', 1, 0), b: animal('cow', 2, 0),
                c: animal('cow', 3, 0), d: animal('cow', 4, 0)
            },
            slots: [item('wheat', 5, 8)]
        });
        bot.activateEntity = async (e) => {
            if (e.id === 'cow-1') throw new Error('out of reach');
            calls.activated.push(e.id);
        };
        const bred = await executeBreeding(bot, { maxPairs: 2 });
        assert.equal(bred, 1, 'first pair failed, second succeeded');
        assert.deepEqual(calls.activated, ['cow-3', 'cow-4']);
    });

    it('executor reports what happened', async () => {
        const { bot } = breedBot({
            entities: { a: animal('sheep', 1, 0), b: animal('sheep', 2, 0) },
            slots: [item('wheat', 5, 4)]
        });
        const msg = await executeHusbandry({ bot }, null, {});
        assert.match(msg, /husbandry: bred 1 pair\(s\) of sheep/);
        const empty = breedBot({ entities: {} });
        assert.match(await executeHusbandry({ bot: empty.bot }, null, {}), /no breedable pairs/);
    });
});

describe('husbandry need', () => {
    const base = {
        tools: [], freeSlots: 20, isNight: false,
        inventoryCounts: { wheat: 4 }, foodCount: 9,
        idleForMs: 120000, husbandryPairs: 2
    };

    it('fires by day when pairs are possible', () => {
        const needs = evaluateNeeds({ ...base }, {});
        const h = needs.find(n => n.kind === 'husbandry');
        assert.ok(h);
        assert.match(h.detail, /breed 2 pair/);
        assert.ok(h.urgency > 0.3, 'outranks idle exploration');
    });

    it('is held at night like other outdoor work', () => {
        const needs = evaluateNeeds({ ...base, isNight: true }, {});
        assert.ok(!needs.some(n => n.kind === 'husbandry'));
    });

    it('is a risky need and a return-home errand', () => {
        assert.ok(RISKY_NEEDS.has('husbandry'));
        assert.ok(RETURN_HOME_KINDS.has('husbandry'));
    });
});
