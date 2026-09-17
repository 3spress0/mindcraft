/**
 * shared_bases.test.js — multi-agent base coordination (GO list: multi-agent
 * outpost coordination). Bots publish homes/outposts to a shared registry;
 * any bot can see and route to companions' bases.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    publishBase, unpublishBase, unpublishOwner,
    listSharedBases, nearestSharedBase, loadRegistry
} from '../src/agent/navigation/shared_bases.js';
import { setHome, setOutpost, removeOutpost } from '../src/agent/navigation/home.js';
import { WorldModel } from '../src/agent/world_model/world_model.js';
import { MemoryBank } from '../src/agent/memory_bank.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-bases-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function agent(name, pos) {
    return {
        bot: { username: name, entity: { position: { ...pos } } },
        world_model: new WorldModel(),
        memory_bank: new MemoryBank(),
        _shared_bases_dir: dir
    };
}

describe('shared registry', () => {
    it('publish, list, and nearest across owners', () => {
        assert.ok(publishBase('andy', 'home', 'home', { x: 0, y: 64, z: 0 }, { dir }));
        assert.ok(publishBase('bella', 'home', 'home', { x: 300, y: 64, z: 300 }, { dir }));
        assert.ok(publishBase('bella', 'outpost', 'mine-camp', { x: 285, y: 40, z: 315 }, { dir }));

        const all = listSharedBases({ dir });
        assert.equal(all.length, 3);
        assert.deepEqual(new Set(all.map(b => b.owner)), new Set(['andy', 'bella']));

        const bellas = listSharedBases({ owner: 'bella', dir });
        assert.equal(bellas.length, 2);

        const nearest = nearestSharedBase({ x: 290, y: 64, z: 310 }, { dir });
        assert.equal(nearest.owner, 'bella');
        assert.equal(nearest.name, 'mine-camp', 'nearest base may be an outpost');
    });

    it('republishing updates in place', () => {
        publishBase('carl', 'home', 'home', { x: 10, y: 64, z: 10 }, { dir });
        publishBase('carl', 'home', 'home', { x: 20, y: 64, z: 20 }, { dir });
        const carls = listSharedBases({ owner: 'carl', dir });
        assert.equal(carls.length, 1);
        assert.equal(carls[0].x, 20);
    });

    it('unpublish removes one base; unpublishOwner removes all', () => {
        assert.ok(unpublishBase('bella', 'mine-camp', { dir }));
        assert.equal(listSharedBases({ owner: 'bella', dir }).length, 1);
        assert.equal(unpublishBase('bella', 'mine-camp', { dir }), false, 'already gone');
        assert.ok(unpublishOwner('bella', { dir }));
        assert.equal(listSharedBases({ owner: 'bella', dir }).length, 0);
    });

    it('registry is a plain JSON file another process can read', () => {
        const raw = loadRegistry(dir);
        assert.ok(raw['andy:home']);
        assert.equal(typeof raw['andy:home'].updatedAt, 'number');
    });
});

describe('home.js integration', () => {
    const a = agent('dora', { x: 50, y: 64, z: 50 });

    it('setHome and setOutpost publish automatically', () => {
        setHome(a);
        a.bot.entity.position = { x: 60, y: 64, z: 60 };
        setOutpost(a, 'watch');

        const dora = listSharedBases({ owner: 'dora', dir });
        assert.equal(dora.length, 2);
        assert.ok(dora.some(b => b.kind === 'home' && b.x === 50));
        assert.ok(dora.some(b => b.kind === 'outpost' && b.name === 'watch'));
    });

    it('removeOutpost unpublishes it', () => {
        assert.ok(removeOutpost(a, 'watch'));
        const dora = listSharedBases({ owner: 'dora', dir });
        assert.equal(dora.length, 1);
        assert.equal(dora[0].kind, 'home');
    });

    it('publishing is best-effort (survives a read-only registry dir)', () => {
        const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
        fs.chmodSync(ro, 0o555);
        try {
            const a = agent('erin', { x: 1, y: 64, z: 1 });
            a._shared_bases_dir = path.join(ro, 'nope');
            const pos = setHome(a); // must not throw
            assert.ok(pos, 'home still set locally');
        } finally {
            fs.chmodSync(ro, 0o755);
            fs.rmSync(ro, { recursive: true, force: true });
        }
    });
});
