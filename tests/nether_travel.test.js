/**
 * nether_travel.test.js — executing the nether shortcut (GO list: portal
 * routing). Walking + waiting for the server-side transition only — never
 * teleporting. Dimensions are scripted by the fake walk callback.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import { executePortalTrip, waitForDimension } from '../src/agent/navigation/portals.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';

let tmp;
let seq = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nether-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Scripted world: `dim` flips when the walk callback says so.
 * portalOverworld / portalNether register remembered portals up front.
 */
function travelAgent({ dim = 'overworld', portalOverworld = null, portalNether = null } = {}) {
    const state = { dimension: dim };
    const walked = [];
    const map = new MentalMap({ botName: `TravelerBot${seq++}`, dir: tmp });
    const agent = {
        bot: {
            game: state,
            entity: { position: new Vec3(0, 64, 0) }
        },
        _mental_map: map
    };
    if (portalOverworld) {
        map.note(portalOverworld, { name: 'portal-overworld', type: 'portal', notes: 'nether portal in overworld' });
    }
    if (portalNether) {
        map.note(portalNether, { name: 'portal-nether', type: 'portal', notes: 'nether portal in the_nether' });
    }
    const goToPosition = async (bot, x, y, z) => {
        walked.push({ x, y, z });
    };
    return { agent, state, walked, goToPosition };
}

const noopSleep = async () => {};

describe('waitForDimension', () => {
    it('resolves when the dimension matches', async () => {
        const { agent, state } = travelAgent({ dim: 'overworld' });
        setTimeout(() => { state.dimension = 'the_nether'; }, 10);
        const ok = await waitForDimension(agent, 'the_nether', { timeoutMs: 500, pollMs: 5 });
        assert.equal(ok, true);
    });

    it('times out honestly when nothing changes', async () => {
        const { agent } = travelAgent({ dim: 'overworld' });
        const ok = await waitForDimension(agent, 'the_nether', { timeoutMs: 30, pollMs: 5, sleep: noopSleep });
        assert.equal(ok, false);
    });
});

describe('executePortalTrip', () => {
    it('needs a destination and a known portal', async () => {
        const { agent, goToPosition } = travelAgent({});
        assert.equal((await executePortalTrip(agent, null, { goToPosition })).ok, false);
        const noPortal = await executePortalTrip(agent, { x: 800, z: -304 }, { goToPosition });
        assert.equal(noPortal.ok, false);
        assert.equal(noPortal.step, 'find-portal');
    });

    it('crosses and walks the nether-side route, surfacing via a known arrival portal', async () => {
        const { agent, state, walked, goToPosition } = travelAgent({
            portalOverworld: { x: 10, y: 64, z: 0 },
            portalNether: { x: 100, y: 64, z: -38 }
        });
        // script: entering the overworld portal flips to nether; entering the
        // nether portal flips back
        const walk = async (bot, x, y, z) => {
            await goToPosition(bot, x, y, z);
            if (x === 10 && state.dimension === 'overworld') state.dimension = 'the_nether';
            else if (x === 100 && state.dimension === 'the_nether') state.dimension = 'overworld';
        };
        const res = await executePortalTrip(agent, { x: 800, z: -304 }, { goToPosition: walk, timeoutMs: 200, pollMs: 5, sleep: noopSleep });
        assert.equal(res.ok, true, res.message);
        assert.equal(res.step, 'arrived');
        // walked: overworld portal -> nether counterpart -> nether portal
        assert.deepEqual(walked.map(w => `${w.x},${w.z}`), ['10,0', '100,-38', '100,-38']);
    });

    it('ends with build guidance when no arrival portal is known', async () => {
        const { agent, state, walked, goToPosition } = travelAgent({
            portalOverworld: { x: 10, y: 64, z: 0 }
        });
        const walk = async (bot, x, y, z) => {
            await goToPosition(bot, x, y, z);
            if (x === 10) state.dimension = 'the_nether';
        };
        const res = await executePortalTrip(agent, { x: 800, z: -304 }, { goToPosition: walk, timeoutMs: 200, pollMs: 5, sleep: noopSleep });
        assert.equal(res.ok, true);
        assert.equal(res.step, 'nether-side');
        assert.match(res.message, /build\/light a portal here/);
        assert.match(res.message, /\(100, -38\)/);
    });

    it('reports a timeout when the portal never transitions', async () => {
        const { agent, goToPosition } = travelAgent({ portalOverworld: { x: 10, y: 64, z: 0 } });
        const res = await executePortalTrip(agent, { x: 800, z: -304 }, { goToPosition, timeoutMs: 30, pollMs: 5, sleep: noopSleep });
        assert.equal(res.ok, false);
        assert.equal(res.step, 'transition');
        assert.match(res.message, /timeout/);
    });

    it('from the nether side, heads for the portal nearest the counterpart spot', async () => {
        const { agent, state, walked, goToPosition } = travelAgent({
            dim: 'the_nether',
            portalNether: { x: 98, y: 64, z: -40 }
        });
        const walk = async (bot, x, y, z) => {
            await goToPosition(bot, x, y, z);
            if (x === 98) state.dimension = 'overworld';
        };
        const res = await executePortalTrip(agent, { x: 800, z: -304 }, { goToPosition: walk, timeoutMs: 200, pollMs: 5, sleep: noopSleep });
        assert.equal(res.ok, true, res.message);
        assert.equal(res.step, 'arrived');
        assert.deepEqual(walked.map(w => `${w.x},${w.z}`), ['98,-40']);
    });

    it('from the nether with no known portal: walk the route and advise building', async () => {
        const { agent, walked, goToPosition } = travelAgent({ dim: 'the_nether' });
        const res = await executePortalTrip(agent, { x: 800, z: -304 }, { goToPosition, timeoutMs: 50, pollMs: 5, sleep: noopSleep });
        assert.equal(res.ok, true);
        assert.equal(res.step, 'nether-side');
        assert.deepEqual(walked.map(w => `${w.x},${w.z}`), ['100,-38']);
    });
});
