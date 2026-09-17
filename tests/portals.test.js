/**
 * portals.test.js — portal locations & routing groundwork (GO list:
 * Navigation > portal locations / portal routing).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import {
    scanPortals, notePortalAt, notePortalsIfNear, listPortals,
    netherCounterpart, overworldCounterpart, planPortalTrip, NETHER_SCALE
} from '../src/agent/navigation/portals.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portals-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function portalBot(portalBlocks) {
    return {
        entity: { position: new Vec3(0, 64, 0) },
        findBlocks: () => portalBlocks.map(b => new Vec3(b.x, b.y, b.z)),
        blockAt: (pos) => {
            const b = portalBlocks.find(q => q.x === pos.x && q.y === pos.y && q.z === pos.z);
            return b ? { name: 'nether_portal', position: pos } : { name: 'stone', position: pos };
        },
        game: { dimension: 'minecraft:overworld' }
    };
}

describe('scanPortals', () => {
    it('clusters adjacent portal blocks into one portal', () => {
        const frame = [
            { x: 10, y: 64, z: 0 }, { x: 10, y: 65, z: 0 }, { x: 10, y: 66, z: 0 },
            { x: 10, y: 64, z: 1 }, { x: 10, y: 65, z: 1 }, { x: 10, y: 66, z: 1 }
        ];
        const bot = portalBot(frame);
        const portals = scanPortals(bot, {});
        assert.equal(portals.length, 1);
        assert.equal(portals[0].blocks, 6);
        assert.equal(portals[0].x, 10);
        assert.equal(portals[0].y, 65);
    });

    it('keeps distant portals separate and sorts nearest first', () => {
        const blocks = [
            { x: 40, y: 64, z: 0 }, // far portal
            { x: 5, y: 64, z: 2 }   // near portal
        ];
        const bot = portalBot(blocks);
        const portals = scanPortals(bot, {});
        assert.equal(portals.length, 2);
        assert.equal(portals[0].x, 5);
        assert.equal(portals[1].x, 40);
    });

    it('no portal blocks -> empty result', () => {
        assert.deepEqual(scanPortals(portalBot([]), {}), []);
        assert.deepEqual(scanPortals({ entity: null }, {}), []);
    });
});

describe('portal memory', () => {
    it('notePortalAt records a portal POI; notePortalsIfNear finds blocks', () => {
        const map = new MentalMap({ botName: 'PortalBot', dir: tmp });
        const agent = { bot: portalBot([{ x: 8, y: 64, z: 0 }]), _mental_map: map };
        const noted = notePortalsIfNear(agent, {});
        assert.equal(noted, 1);
        const portals = listPortals(agent);
        assert.equal(portals.length, 1);
        assert.match(portals[0].name, /^portal-/);
        assert.match(portals[0].notes, /overworld/);
    });

    it('notePortalAt tolerates missing memory layers', () => {
        const pos = notePortalAt({}, { x: 1.4, y: 64, z: 2.6 }, 'the_nether');
        assert.deepEqual(pos, { x: 1, y: 64, z: 3 });
        assert.equal(notePortalAt({}, null), null);
    });
});

describe('portal math and planning', () => {
    it('1:8 conversion both ways', () => {
        assert.equal(NETHER_SCALE, 8);
        assert.deepEqual(netherCounterpart({ x: 800, z: -304 }), { x: 100, y: 64, z: -38 });
        assert.deepEqual(overworldCounterpart({ x: 100, z: -38 }), { x: 800, y: 64, z: -304 }); // round-trip
        assert.deepEqual(netherCounterpart({ x: 0, y: 70, z: 0 }), { x: 0, y: 70, z: 0 });
    });

    it('plans an overworld-origin trip with steps and known portal', () => {
        const map = new MentalMap({ botName: 'PlannerBot', dir: tmp });
        const agent = {
            bot: { game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) } },
            _mental_map: map
        };
        notePortalAt(agent, { x: 12, y: 64, z: 0 }, 'overworld');
        const plan = planPortalTrip(agent, { x: 800, z: -304 });
        assert.equal(plan.portalKnown, true);
        assert.ok(plan.steps.length >= 3);
        assert.match(plan.steps.join(' '), /100, -38/, 'includes the nether target');
        assert.match(plan.steps.join(' '), /portal-overworld/);
    });

    it('plans from the nether side and handles unknown portals', () => {
        const agent = {
            bot: { game: { dimension: 'the_nether' }, entity: { position: new Vec3(0, 64, 0) } },
            _mental_map: new MentalMap({ botName: 'NetherBot', dir: tmp })
        };
        const plan = planPortalTrip(agent, { x: 800, z: -304 });
        assert.equal(plan.portalKnown, false);
        assert.match(plan.steps.join(' '), /Build a portal near \(100, -38\)/);
    });

    it('rejects unusable destinations politely', () => {
        const plan = planPortalTrip({}, null);
        assert.equal(plan.netherTarget, null);
        assert.match(plan.steps[0], /destination/i);
    });
});
