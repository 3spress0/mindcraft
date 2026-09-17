import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { scanDarkSpots, executeBaseMaintenance } from '../src/agent/autonomy/base.js';
import { evaluateNeeds } from '../src/agent/autonomy/needs.js';

function darkLightProvider(darkPositions) {
    const keys = new Set(darkPositions.map(p => `${p.x},${p.y},${p.z}`));
    return (pos) => (keys.has(`${pos.x},${pos.y},${pos.z}`) ? 2 : 14);
}

describe('scanDarkSpots', () => {
    it('finds dark positions around a center, darkest first', () => {
        const dark = [{ x: 2, y: 64, z: 0 }, { x: -3, y: 64, z: 2 }, { x: 2, y: 65, z: 0 }];
        const bot = { entity: { position: new Vec3(0, 64, 0) } };
        const spots = scanDarkSpots(bot, { radius: 8, lightProvider: darkLightProvider(dark) });
        assert.equal(spots.length, 3);
        assert.ok(spots.every(s => s.light <= 6));
    });

    it('respects radius bounds', () => {
        const dark = [{ x: 30, y: 64, z: 0 }]; // outside radius 8
        const bot = { entity: { position: new Vec3(0, 64, 0) } };
        const spots = scanDarkSpots(bot, { radius: 8, lightProvider: darkLightProvider(dark) });
        assert.equal(spots.length, 0);
    });

    it('caps the number of spots', () => {
        const dark = [];
        for (let dx = -16; dx <= 16; dx++) dark.push({ x: dx, y: 64, z: 0 });
        const bot = { entity: { position: new Vec3(0, 64, 0) } };
        const spots = scanDarkSpots(bot, { radius: 16, maxLight: 6, lightProvider: darkLightProvider(dark) });
        assert.ok(spots.length <= 32);
    });

    it('handles missing position or failing provider', () => {
        assert.deepEqual(scanDarkSpots({}, {}), []);
        const bot = { entity: { position: new Vec3(0, 64, 0) } };
        const spots = scanDarkSpots(bot, { lightProvider: () => { throw new Error('x'); } });
        assert.equal(spots.length, 0);
    });
});

describe('executeBaseMaintenance', () => {
    it('requires a bot', async () => {
        assert.match(await executeBaseMaintenance({}, {}), /no bot/);
    });

    it('reports a well-lit area', async () => {
        const agent = {
            bot: { entity: { position: new Vec3(0, 64, 0) }, lightAt: () => 14, inventory: { slots: [] } },
            memory_bank: { recallPlace: (k) => (k === 'home' ? [0, 64, 0] : null) }
        };
        const msg = await executeBaseMaintenance(agent, {}, {});
        assert.match(msg, /well lit/);
    });

    it('reports dark spots but no torches', async () => {
        const dark = [{ x: 2, y: 64, z: 0 }];
        const keys = new Set(dark.map(p => `${p.x},${p.y},${p.z}`));
        const agent = {
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                lightAt: (p) => (keys.has(`${p.x},${p.y},${p.z}`) ? 1 : 14),
                inventory: { slots: [] } // no torches
            },
            memory_bank: { recallPlace: (k) => (k === 'home' ? [0, 64, 0] : null) }
        };
        const msg = await executeBaseMaintenance(agent, {}, {});
        assert.match(msg, /no torches/);
    });
});

describe('maintain_base need wiring', () => {
    it('fires at night with home, dark spots, and torches', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, isNight: true,
            inventoryCounts: { torch: 5 }, foodCount: 9,
            homeSet: true, darkSpots: 4
        }, {});
        const mb = needs.find(n => n.kind === 'maintain_base');
        assert.ok(mb);
        assert.match(mb.detail, /4 dark spot/);
        assert.equal(mb.urgency, 0.45); // night urgency
    });

    it('lower urgency in daytime, but still beats idle exploration', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 120000, isNight: false,
            inventoryCounts: { torch: 5 }, foodCount: 9,
            homeSet: true, darkSpots: 4
        }, {});
        const mb = needs.find(n => n.kind === 'maintain_base');
        assert.equal(mb.urgency, 0.35);
        const explore = needs.find(n => n.kind === 'explore');
        assert.ok(explore);
        assert.ok(mb.urgency > explore.urgency, 'lighting the base beats wandering');
    });

    it('no need without torches or without home', () => {
        const base = { tools: [], freeSlots: 10, idleForMs: 0, isNight: true, foodCount: 9, darkSpots: 4 };
        assert.ok(!evaluateNeeds({ ...base, inventoryCounts: {}, homeSet: true }, {}).some(n => n.kind === 'maintain_base'));
        assert.ok(!evaluateNeeds({ ...base, inventoryCounts: { torch: 5 }, homeSet: false }, {}).some(n => n.kind === 'maintain_base'));
    });

    it('rest need appears at night with a known bed', () => {
        const needs = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, isNight: true,
            inventoryCounts: {}, foodCount: 9, bedKnown: true
        }, {});
        const rest = needs.find(n => n.kind === 'rest');
        assert.ok(rest);
        assert.equal(rest.urgency, 0.5);
        // not during the day
        const day = evaluateNeeds({
            tools: [], freeSlots: 10, idleForMs: 0, isNight: false,
            inventoryCounts: {}, foodCount: 9, bedKnown: true
        }, {});
        assert.ok(!day.some(n => n.kind === 'rest'));
    });
});
