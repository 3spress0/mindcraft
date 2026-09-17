import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HARD_HAZARDS, SOFT_HAZARDS, hazardTier, isHazard,
    hardenMovements, scanHazards, hazardReport
} from '../src/agent/navigation/hazards.js';

describe('navigation hazards classification', () => {
    it('classifies hard and soft hazards', () => {
        assert.equal(hazardTier('lava'), 'hard');
        assert.equal(hazardTier('magma_block'), 'hard');
        assert.equal(hazardTier('sweet_berry_bush'), 'hard');
        assert.equal(hazardTier('soul_sand'), 'soft');
        assert.equal(hazardTier('cobweb'), 'soft');
        assert.equal(hazardTier('stone'), null);
        assert.equal(hazardTier(undefined), null);
        assert.ok(isHazard('fire'));
        assert.ok(!isHazard('dirt'));
    });

    it('lists are non-trivial and disjoint', () => {
        assert.ok(HARD_HAZARDS.length >= 8);
        assert.ok(SOFT_HAZARDS.length >= 2);
        for (const name of SOFT_HAZARDS) assert.ok(!HARD_HAZARDS.includes(name));
    });
});

describe('hardenMovements', () => {
    it('adds hazard ids to blocksToAvoid (registry-first)', () => {
        const registry = {
            blocksByName: {
                lava: { id: 11 }, magma_block: { id: 12 }, sweet_berry_bush: { id: 13 },
                soul_sand: { id: 14 }, cactus: { id: 15 }
            }
        };
        const movements = { blocksToAvoid: new Set([99]) };
        hardenMovements(movements, { registry });
        for (const id of [11, 12, 13, 14, 15]) assert.ok(movements.blocksToAvoid.has(id));
        assert.ok(movements.blocksToAvoid.has(99), 'existing entries preserved');
    });

    it('can skip soft hazards', () => {
        const registry = { blocksByName: { lava: { id: 11 }, soul_sand: { id: 14 } } };
        const movements = { blocksToAvoid: new Set() };
        hardenMovements(movements, { registry }, { includeSoft: false });
        assert.ok(movements.blocksToAvoid.has(11));
        assert.ok(!movements.blocksToAvoid.has(14));
    });

    it('tolerates missing registry/movements', () => {
        assert.equal(hardenMovements(null, {}), null);
        const m = { blocksToAvoid: new Set() };
        hardenMovements(m, {});
        assert.equal(m.blocksToAvoid.size, 0);
    });
});

function worldWithHazards() {
    const hazards = {
        '2,64,0': 'lava',
        '-3,64,4': 'magma_block',
        '0,64,8': 'soul_sand',
        '20,64,20': 'lava' // outside radius 8
    };
    return {
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: (p) => {
            const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
            const name = hazards[k];
            return name ? { name, boundingBox: name === 'soul_sand' ? 'block' : 'empty' } : { name: 'air', boundingBox: 'empty' };
        }
    };
}

describe('scanHazards', () => {
    it('finds hazards sorted by distance', () => {
        const bot = worldWithHazards();
        const found = scanHazards(bot, { radius: 8 });
        assert.ok(found.length >= 3);
        assert.deepEqual(found[0], { name: 'lava', tier: 'hard', x: 2, y: 64, z: 0, dist: 2 });
        for (let i = 1; i < found.length; i++) assert.ok(found[i].dist >= found[i - 1].dist);
        assert.ok(!found.some(h => h.x === 20), 'out-of-radius hazard excluded');
    });

    it('honors includeSoft=false and caps radius', () => {
        const bot = worldWithHazards();
        const hardOnly = scanHazards(bot, { radius: 99, includeSoft: false });
        assert.ok(!hardOnly.some(h => h.tier === 'soft'));
        assert.ok(hardOnly.some(h => h.x === 20), 'radius capped at 24 now includes the far lava');
    });

    it('handles missing bot/position gracefully', () => {
        assert.deepEqual(scanHazards({}, {}), []);
        assert.deepEqual(scanHazards({ entity: {} }, {}), []);
    });

    it('hazardReport formats a readable summary', () => {
        const bot = worldWithHazards();
        const report = hazardReport(bot, { radius: 8 });
        assert.match(report, /lava/);
        assert.match(report, /magma_block/);
        assert.match(report, /dangerous/);
        assert.equal(hazardReport({ entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }), 'No hazards detected nearby.');
    });
});
