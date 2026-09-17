/**
 * combat.test.js — combat polish (GO list: threat scoring, shield handling,
 * emergency escape). Defensive posture only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    THREAT_TABLE, distanceFactor, scoreThreats, threatLevel,
    bestWeapon, combatReady, decideEscape, executeEscape
} from '../src/agent/autonomy/combat.js';

function item(name, slot, count = 1) {
    return { name, slot, count, type: slot, maxDurability: null, durabilityUsed: 0 };
}

function mob(name, x, z, y = 64) {
    return { name, position: new Vec3(x, y, z) };
}

function combatBot({ entities = {}, slots = [], health = 20 } = {}) {
    const equips = [];
    return {
        bot: {
            entity: { position: new Vec3(0, 64, 0) },
            entities,
            health,
            inventory: { slots },
            equip: async (it, dest) => { equips.push({ item: it.name, dest }); }
        },
        equips
    };
}

describe('threat scoring', () => {
    it('weights dangerous mobs above cannon fodder', () => {
        assert.ok(THREAT_TABLE.creeper > THREAT_TABLE.zombie);
        assert.ok(THREAT_TABLE.skeleton > THREAT_TABLE.spider);
        assert.ok(THREAT_TABLE.ravager > THREAT_TABLE.zombie);
    });

    it('distance factor: full when close, zero when far, linear between', () => {
        assert.equal(distanceFactor(0), 1);
        assert.equal(distanceFactor(4), 1);
        assert.equal(distanceFactor(16), 0);
        assert.equal(distanceFactor(100), 0);
        const mid = distanceFactor(10); // halfway between 4 and 16
        assert.ok(mid > 0.4 && mid < 0.6);
    });

    it('scores nearby hostiles, sorts by score, and buckets the situation', () => {
        const { bot } = combatBot({
            entities: {
                a: mob('creeper', 2, 0),     // adjacent-ish: ~3.0
                b: mob('zombie', 3, 0),      // ~1.6
                c: mob('skeleton', 14, 0),   // far: reduced
                d: mob('cow', 1, 0)          // not hostile: ignored
            }
        });
        const res = scoreThreats(bot, { radius: 16 });
        assert.deepEqual(res.threats.map(t => t.name), ['creeper', 'zombie', 'skeleton']);
        assert.ok(res.total > 4.5, `creeper + zombie + distant skeleton = ${res.total}`);
        assert.equal(res.level, 'overwhelm');
    });

    it('quiet scenes stay clear', () => {
        const { bot } = combatBot({ entities: { c: mob('cow', 2, 0) } });
        const res = scoreThreats(bot, {});
        assert.equal(res.total, 0);
        assert.equal(res.level, 'clear');
    });

    it('levels bucket sensibly', () => {
        assert.equal(threatLevel(0), 'clear');
        assert.equal(threatLevel(1.5), 'skirmish');
        assert.equal(threatLevel(3), 'danger');
        assert.equal(threatLevel(6), 'overwhelm');
    });
});

describe('combat readiness', () => {
    it('picks the best weapon by tier', () => {
        const { bot } = combatBot({ slots: [item('wooden_sword', 5), item('iron_sword', 6)] });
        assert.equal(bestWeapon(bot), 'iron_sword');
        const empty = combatBot({});
        assert.equal(bestWeapon(empty.bot), null);
    });

    it('equips weapon to hand and shield to off-hand', async () => {
        const { bot, equips } = combatBot({
            slots: [item('diamond_sword', 5), item('shield', 6), item('bread', 7)]
        });
        const done = await combatReady(bot);
        assert.deepEqual(done, ['diamond_sword', 'shield']);
        assert.ok(equips.some(e => e.item === 'diamond_sword' && e.dest === 'hand'));
        assert.ok(equips.some(e => e.item === 'shield' && e.dest === 'off-hand'));
    });

    it('survives a bot that cannot equip', async () => {
        const { bot } = combatBot({ slots: [item('iron_sword', 5)] });
        bot.equip = async () => { throw new Error('locked'); };
        assert.deepEqual(await combatReady(bot), []);
    });
});

describe('escape decisions', () => {
    it('flees at critical health even against one zombie', () => {
        const { bot } = combatBot({ entities: { z: mob('zombie', 3, 0) }, health: 4 });
        const d = decideEscape(bot, {});
        assert.equal(d.flee, true);
        assert.match(d.reason, /health 4\/20/);
    });

    it('flees when overwhelmed, holds when manageable', () => {
        const bad = combatBot({
            entities: { a: mob('creeper', 2, 0), b: mob('skeleton', 3, 0), c: mob('zombie', 2, 2) },
            health: 18
        });
        assert.equal(decideEscape(bad.bot, {}).flee, true);
        const fine = combatBot({ entities: { z: mob('zombie', 12, 0) }, health: 18 });
        assert.equal(decideEscape(fine.bot, {}).flee, false);
    });

    it('executeEscape shields up and backs off', async () => {
        const { bot } = combatBot({ slots: [item('shield', 5), item('stone_sword', 6)] });
        // skills.moveAway needs modes/pathfinder; cheat-mode bot walks away via chat
        bot.modes = { isOn: (m) => m === 'cheat' };
        bot.chat = () => {};
        const msg = await executeEscape({ bot }, { distance: 8 });
        assert.match(msg, /escape:/);
        assert.match(msg, /shield up|backed off|could not move/);
    });

    it('executeEscape never throws', async () => {
        const msg = await executeEscape({}, {});
        assert.equal(msg, 'escape: no bot');
    });
});
