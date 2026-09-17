/**
 * caves.test.js — cave awareness (GO list: Navigation > cave awareness).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import {
    isUnderground, scanCaveOpenings, noteCavesIfNear, listCaves, DARK_THRESHOLD,
    assessCaveSafety, enterCave
} from '../src/agent/navigation/caves.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caves-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Fake world: registered columns by "x,z"; blockAt resolves floor/ceiling;
 * lightAt is per-position override (default 15).
 */
function caveBot({ openings = [], lights = {} } = {}) {
    return {
        entity: { position: new Vec3(0, 64, 0) },
        findBlocks: () => openings.map(o => new Vec3(o.x, o.y, o.z)),
        blockAt: (pos) => {
            for (const o of openings) {
                if (o.x === pos.x && o.z === pos.z) {
                    if (pos.y === o.y) return { name: 'air', position: pos };          // the opening
                    if (pos.y === o.y - 1) return { name: 'stone', position: pos };    // floor
                    if (pos.y === o.y + 1) return { name: 'air', position: pos };      // open above
                }
            }
            return { name: pos.y <= 63 ? 'stone' : 'air', position: pos };
        },
        lightAt: (pos) => lights[`${pos.x},${pos.y},${pos.z}`] ?? 15
    };
}

describe('isUnderground', () => {
    it('detects no skylight overhead', () => {
        const bot = {
            entity: { position: new Vec3(0, 20, 0) },
            blockAt: (pos) => ({ name: 'stone', skyLight: 0, position: pos })
        };
        assert.equal(isUnderground(bot), true);
        const surface = {
            entity: { position: new Vec3(0, 64, 0) },
            blockAt: (pos) => ({ name: 'air', skyLight: 15, position: pos })
        };
        assert.equal(isUnderground(surface), false);
    });

    it('is safe with a broken bot', () => {
        assert.equal(isUnderground({}), false);
        assert.equal(isUnderground({ entity: null }), false);
    });
});

describe('scanCaveOpenings', () => {
    it('finds dark walk-in openings, sorted by distance', () => {
        const bot = caveBot({
            openings: [
                { x: 20, y: 64, z: 0 },  // far
                { x: 4, y: 64, z: 0 }    // near
            ],
            lights: { '4,64,0': 2, '20,64,0': 1 }
        });
        const scan = scanCaveOpenings(bot, { radius: 32 });
        assert.deepEqual(scan.map(s => s.x), [4, 20]);
        assert.ok(scan.every(s => s.light <= DARK_THRESHOLD));
    });

    it('skips lit openings (not caves) and unopenable holes', () => {
        const bot = caveBot({
            openings: [
                { x: 3, y: 64, z: 0 },   // lit -> skip
                { x: 5, y: 64, z: 0 }    // covered above -> skip
            ],
            lights: { '3,64,0': 14 }
        });
        bot.blockAt = (pos) => {
            if (pos.x === 5 && pos.z === 0 && pos.y === 65) return { name: 'stone', position: pos };
            return caveBot({ openings: [{ x: 3, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }] }).blockAt(pos);
        };
        bot.lightAt = (pos) => (pos.x === 3 ? 14 : 1);
        assert.equal(scanCaveOpenings(bot, {}).length, 0);
    });

    it('respects maxOpenings and survives missing light API', () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ x: i + 1, y: 64, z: 0 }));
        const bot = caveBot({ openings: many });
        bot.lightAt = () => 0; // everything dark
        const scan = scanCaveOpenings(bot, { maxOpenings: 5 });
        assert.equal(scan.length, 5);
        const noLight = caveBot({ openings: [{ x: 2, y: 64, z: 0 }] });
        delete noLight.lightAt;
        assert.equal(scanCaveOpenings(noLight, {}).length, 0, 'unknown light -> assumed safe (15)');
    });
});

describe('noteCavesIfNear / listCaves', () => {
    it('notes caves once and reads them back', () => {
        const map = new MentalMap({ botName: 'CaveBot', dir: tmp });
        const agent = {
            bot: caveBot({ openings: [{ x: 6, y: 64, z: 0 }] }),
            _mental_map: map
        };
        agent.bot.lightAt = () => 0;
        const noted = noteCavesIfNear(agent, {});
        assert.equal(noted, 1);
        const again = noteCavesIfNear(agent, {});
        assert.equal(again, 0, 'deduplicated on second pass');
        const caves = listCaves(agent);
        assert.equal(caves.length, 1);
        assert.match(caves[0].name, /^cave-/);
    });

    it('also records a world-model fact', () => {
        const facts = { location: [] };
        const agent = {
            bot: caveBot({ openings: [{ x: 9, y: 64, z: 1 }] }),
            world_model: { record: (kind, fact) => facts.location.push(fact) }
        };
        agent.bot.lightAt = () => 2;
        noteCavesIfNear(agent, {});
        assert.ok(facts.location.some(f => f.key?.startsWith('cave:') && f.kind === 'cave'));
    });
});

describe('cave safety & guided entry', () => {
    it('assessCaveSafety flags lava/fire at the mouth', () => {
        const bot = caveBot({ openings: [{ x: 6, y: 64, z: 0 }] });
        // lava pool right next to the opening
        bot.findBlocks = () => [new Vec3(7, 63, 0), new Vec3(6, 64, 0)];
        bot.blockAt = (pos) => {
            if (pos.x === 7 && pos.y === 63) return { name: 'lava', position: pos };
            if (pos.x === 6 && pos.y === 64) return { name: 'air', position: pos };
            return { name: 'stone', position: pos };
        };
        const safety = assessCaveSafety(bot, { x: 6, y: 64, z: 0 }, {});
        assert.equal(safety.safe, false);
        assert.equal(safety.lavaNear, 1);
        assert.deepEqual(safety.dangers, ['lava']);
    });

    it('a clean mouth is safe', () => {
        const bot = caveBot({ openings: [{ x: 6, y: 64, z: 0 }] });
        bot.lightAt = () => 2;
        const safety = assessCaveSafety(bot, { x: 6, y: 64, z: 0 }, {});
        assert.equal(safety.safe, true);
        assert.equal(safety.lightLevel, 2);
    });

    it('enterCave refuses unknown caves and dangerous mouths', async () => {
        const map = new MentalMap({ botName: 'EntryBot', dir: tmp });
        map.note({ x: 6, y: 64, z: 0 }, { name: 'cave-6-0', type: 'cave' });
        const bot = caveBot({ openings: [{ x: 6, y: 64, z: 0 }] });
        bot.findBlocks = () => [new Vec3(7, 63, 0)];
        bot.blockAt = (pos) => (pos.x === 7 && pos.y === 63)
            ? { name: 'lava', position: pos }
            : caveBot({ openings: [{ x: 6, y: 64, z: 0 }] }).blockAt(pos);
        const agent = { bot, _mental_map: map };

        assert.match(await enterCave(agent, 'nowhere'), /don't remember/);
        assert.match(await enterCave(agent, 'cave-6-0'), /dangerous \(lava/);
    });

    it('enterCave lights the entrance and walks to a safe cave', async () => {
        const map = new MentalMap({ botName: 'EntryBot2', dir: tmp });
        map.note({ x: 9, y: 64, z: 3 }, { name: 'cave-9-3', type: 'cave' });
        const bot = caveBot({ openings: [{ x: 9, y: 64, z: 3 }] });
        bot.lightAt = () => 1;
        bot.inventory = { slots: [{ name: 'torch', slot: 5, count: 3, type: 5 }] };
        bot.game = { gameMode: 'survival' };
        bot.modes = { isOn: (m) => m === 'cheat' }; // goToPosition teleports
        bot.chat = () => {};
        bot._personality = {};
        bot.equip = async () => {};
        const placed = [];
        bot.placeBlock = async (block) => { placed.push(block.position); };

        const agent = { bot, _mental_map: map };
        const msg = await enterCave(agent, 'cave-9-3');
        assert.match(msg, /entered "cave-9-3"/);
        assert.match(msg, /torch placed at the entrance/);
        assert.match(msg, /at the cave mouth/);
        assert.equal(placed.length, 1, 'torch placed on the entrance floor');
    });
});

describe('cave path profile (baritone posture)', () => {
    it('cave profile exists, is hazard-aware, and applies to movements', async () => {
        const { PROFILES, profileAvoidsHazards, applyProfile, setProfileName, getProfileName } =
            await import('../src/agent/baritone/settings.js');
        assert.ok(PROFILES.cave, 'cave profile registered');
        assert.equal(profileAvoidsHazards('cave'), true);
        const movements = { canDig: false, allowSprinting: true, maxDropDown: 99, digCost: 100, placeCost: 100 };
        applyProfile(movements, 'cave');
        assert.equal(movements.canDig, true, 'caving may clear gravel');
        assert.equal(movements.allowSprinting, false);
        assert.ok(movements.maxDropDown <= 3, 'small drops underground');
        const fakeBot = {};
        setProfileName(fakeBot, 'cave');
        assert.equal(getProfileName(fakeBot), 'cave');
    });

    it('enterCave switches the path profile to cave', async () => {
        const map = new MentalMap({ botName: 'ProfileCaveBot', dir: tmp });
        map.note({ x: 4, y: 64, z: 2 }, { name: 'cave-4-2', type: 'cave' });
        const bot = caveBot({ openings: [{ x: 4, y: 64, z: 2 }] });
        bot.lightAt = () => 2;
        bot.inventory = { slots: [] };
        bot.game = { gameMode: 'survival' };
        bot.modes = { isOn: (m) => m === 'cheat' };
        bot.chat = () => {};
        bot._personality = {};
        const agent = { bot, _mental_map: map };
        const msg = await enterCave(agent, 'cave-4-2');
        assert.match(msg, /path profile default -> cave/);
        assert.equal(bot._baritone_profile, 'cave');
        assert.equal(bot._cave_prev_profile, 'default');
    });
});
