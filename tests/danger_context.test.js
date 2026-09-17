/**
 * danger_context.test.js — feeding monsters/danger into the LLM context
 * (GO list: legit awareness). Everything here is server-reported data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { dangerSummary, dangerReport } from '../src/agent/sensors/danger.js';

function mob(name, x, z) {
    return { name, position: new Vec3(x, 64, z) };
}

function dangerBot({ entities = {}, lava = null, sky = 15, light = 15, health = 20 } = {}) {
    return {
        entity: { position: new Vec3(0, 64, 0) },
        entities,
        health,
        time: { timeOfDay: 6000 },
        lightAt: () => light,
        blockAt: (pos) => {
            if (lava && pos.x === lava.x && pos.y === lava.y && pos.z === lava.z) {
                return { name: 'lava', position: pos };
            }
            if (pos.y >= 66) return { name: 'air', skyLight: sky, position: pos };
            return { name: 'stone', skyLight: sky, position: pos };
        }
    };
}

describe('dangerSummary', () => {
    it('collects threats, hazards, risk, underground and light into one bounded object', () => {
        const bot = dangerBot({
            entities: { a: mob('creeper', 3, 0), b: mob('zombie', 10, 0), c: mob('cow', 2, 0) },
            lava: { x: 5, y: 63, z: 1 },
            light: 3
        });
        const d = dangerSummary(bot, {});
        // threats: hostile only, scored, capped fields present
        assert.deepEqual(d.threats.map(t => t.name), ['creeper', 'zombie']);
        assert.ok(d.threatTotal > 3);
        assert.equal(d.threatLevel, 'danger');
        // risk from autonomy layer
        assert.ok(['none', 'low', 'high'].includes(d.risk.level));
        // hazards: the lava block, deduped by name
        assert.ok(d.hazards.some(h => h.name === 'lava'));
        assert.equal(d.hazards.find(h => h.name === 'lava').tier, 'hard');
        // environment
        assert.equal(d.underground, false);
        assert.equal(d.light, 3);
    });

    it('knows when the bot is underground', () => {
        const bot = dangerBot({ sky: 0 });
        const d = dangerSummary(bot, {});
        assert.equal(d.underground, true);
    });

    it('caps threats and reports the overflow', () => {
        const entities = {};
        for (let i = 0; i < 12; i++) entities[`z${i}`] = mob('zombie', 2 + i, 0);
        const bot = dangerBot({ entities });
        const d = dangerSummary(bot, { maxThreats: 5 });
        assert.equal(d.threats.length, 5);
        assert.equal(d.threatsMore, 7);
    });

    it('empty scene -> calm summary, never throws', () => {
        const d = dangerSummary(dangerBot({}), {});
        assert.equal(d.threatLevel, 'clear');
        assert.equal(d.threats.length, 0);
        assert.equal(d.hazards.length, 0);
        assert.equal(dangerSummary(null, {}).threatLevel, 'clear');
    });

    it('survives broken sensors field by field', () => {
        const bot = dangerBot({ entities: { a: mob('zombie', 2, 0) } });
        bot.blockAt = () => { throw new Error('chunk gone'); };
        bot.lightAt = () => { throw new Error('no light api'); };
        const d = dangerSummary(bot, {});
        assert.equal(d.threats.length, 1, 'threats still reported');
        assert.equal(d.hazards.length, 0, 'hazards degrade to none');
        assert.equal(d.light, 15, 'broken light API degrades to the safe default');
    });
});

describe('dangerReport', () => {
    it('renders a compact digest', () => {
        const bot = dangerBot({
            entities: { a: mob('skeleton', 4, 0) },
            lava: { x: 6, y: 63, z: 0 },
            light: 2,
            sky: 0
        });
        const report = dangerReport(bot, {});
        assert.match(report, /risk /);
        assert.match(report, /skeleton 4m/);
        assert.match(report, /lava ~6m/);
        assert.match(report, /underground/);
        assert.match(report, /dark \(light 2\)/);
    });

    it('says so when all is calm', () => {
        const report = dangerReport(dangerBot({}), {});
        assert.match(report, /no hostiles in range/);
    });
});

describe('LLM context wiring (full_state)', () => {
    it('getFullState carries the danger section', async () => {
        const { getFullState } = await import('../src/agent/library/full_state.js');
        const bot = dangerBot({ entities: { a: mob('creeper', 2, 0) } });
        // minimal agent/bot surface getFullState expects
        bot.game = { dimension: 'overworld', gameMode: 'survival' };
        bot.food = 18;
        bot.thunderState = 0;
        bot.rainState = 0;
        bot.time = { timeOfDay: 6000 };
        bot.inventory = {
            slots: new Array(46).fill(null),
            items: () => []
        };
        bot.heldItem = null;
        bot.modes = { getMiniDocs: () => 'modes docs' };
        bot.players = {};
        const agent = {
            name: 'DangerBot',
            bot,
            isIdle: () => true,
            actions: { currentActionLabel: null },
            self_prompter: { isStopped: () => false, isPaused: () => false, isActive: () => false }
        };
        const state = getFullState(agent);
        assert.ok(state.danger, 'danger section present in LLM state');
        assert.equal(state.danger.threats[0].name, 'creeper');
        assert.ok(state.nearby, 'existing sections intact');
        assert.equal(state.gameplay.health, 20);
    });
});
