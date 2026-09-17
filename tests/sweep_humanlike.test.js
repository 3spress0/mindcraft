/**
 * sweep_humanlike.test.js — humanlike reactions, expedition prep, resource
 * reservations, spatial index, pause/cancel, risky-action confirmation.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { contextReactionMs, hesitate, chooseFood, sortWarranted, routeReconsiderationDue, HIGH_VALUE_FOODS } from '../src/agent/humanlike/reactions.js';
import { expeditionChecklist, kitCount, planForEnvironment, environmentContext, EXPEDITION_KITS } from '../src/agent/autonomy/expedition.js';
import { ResourceReservations } from '../src/agent/storage/reservations.js';
import { buildChunkIndex, factsNear, chunkKeyOf, indexSummary } from '../src/agent/world_model/spatial_index.js';
import { pauseAll, resumeAll, pauseStatus, cancelWithReason } from '../src/agent/library/pause.js';
import { checkConfirmation, consumeConfirmation, confirmGateEnabled, RISKY_ACTIONS } from '../src/agent/commands/confirm.js';
import { createRng } from '../src/agent/humanlike/rng.js';
import settings from '../settings.js';

describe('context-dependent reactions', () => {
    it('urgent reactions are faster than relaxed ones', () => {
        const agent = { personality: null };
        const urgent = contextReactionMs(agent, { urgency: 'urgent' });
        const relaxed = contextReactionMs(agent, { urgency: 'relaxed' });
        assert.ok(urgent < relaxed, `${urgent} should be < ${relaxed}`);
    });

    it('personality timing shapes the delay but stays bounded', () => {
        const agent = { personality: { timing: (ms) => ms * 100 } }; // absurd multiplier
        const ms = contextReactionMs(agent, { urgency: 'normal' });
        assert.ok(ms <= 1500, `bounded, got ${ms}`);
    });

    it('hesitate sleeps within bounds and reports the wait', async () => {
        let slept = 0;
        const agent = { personality: { traits: { caution: 0.9 } } };
        const ms = await hesitate(agent, 'dig down', { risk: 'high', maxMs: 500, sleep: async (t) => { slept = t; } });
        assert.ok(ms > 0 && ms <= 500);
        assert.equal(slept, ms);
    });

    it('route reconsideration is seeded, bounded, and distance-gated', () => {
        const rng = createRng('test-reconsider');
        assert.equal(routeReconsiderationDue(rng, { distTraveled: 5, minDist: 24 }), false, 'too short to reconsider');
        let dueCount = 0;
        for (let i = 0; i < 200; i++) {
            const r = createRng(`roll-${i}`);
            if (routeReconsiderationDue(r, { distTraveled: 30, minDist: 24, chance: 0.12 })) dueCount++;
        }
        assert.ok(dueCount > 0 && dueCount < 100, `occasional, not constant: ${dueCount}/200`);
    });
});

describe('food selection by context', () => {
    const items = [
        { name: 'golden_carrot', count: 1 },
        { name: 'bread', count: 12 },
        { name: 'apple', count: 3 }
    ];

    it('settle context prefers high-value food', () => {
        assert.equal(chooseFood(items, 'settle'), 'golden_carrot');
    });

    it('combat context prefers quick food', () => {
        assert.equal(chooseFood(items, 'combat'), 'bread');
    });

    it('normal context takes the most plentiful', () => {
        assert.equal(chooseFood(items, 'normal'), 'bread');
    });

    it('returns null with nothing edible', () => {
        assert.equal(chooseFood([{ name: 'iron_ingot', count: 5 }], 'normal'), null);
        assert.equal(HIGH_VALUE_FOODS.includes('golden_carrot'), true);
    });
});

describe('inventory rearrangement guard', () => {
    it('tidy chest is not worth sorting', () => {
        const slots = [
            { name: 'cobblestone' }, { name: 'cobblestone' }, { name: 'cobblestone' },
            { name: 'dirt' }, { name: 'dirt' }, null, null
        ];
        assert.equal(sortWarranted(slots).warranted, false);
    });

    it('scattered chest is worth sorting', () => {
        const slots = [];
        for (let i = 0; i < 12; i++) slots.push({ name: i % 2 ? 'cobblestone' : 'dirt' });
        const res = sortWarranted(slots);
        assert.equal(res.warranted, true);
        assert.ok(res.runs > 6);
    });

    it('tiny containers are never worth it', () => {
        assert.equal(sortWarranted([{ name: 'a' }, { name: 'b' }]).warranted, false);
    });
});

describe('expedition preparation', () => {
    function botWith(counts) {
        const placed = [];
        let slot = 9;
        for (const [name, count] of Object.entries(counts)) {
            placed.push({ name, count, slot });
            slot++;
        }
        return { inventory: { slots: new Array(46).fill(null).map((s, i) => placed.find(x => x.slot === i) ?? null) } };
    }

    it('kitCount aggregates families (food, pickaxes, swords)', () => {
        const counts = { bread: 4, apple: 2, iron_pickaxe: 1, wooden_sword: 1 };
        assert.equal(kitCount(counts, 'food_any'), 6);
        assert.equal(kitCount(counts, 'pickaxe_any'), 1);
        assert.equal(kitCount(counts, 'sword_any'), 1);
        assert.equal(kitCount(counts, 'torch'), 0);
    });

    it('checklist reports exactly what is missing', () => {
        const bot = botWith({ bread: 10, torch: 20, iron_pickaxe: 1, wooden_sword: 1 });
        const list = expeditionChecklist(bot, { kind: 'exploring' });
        const shield = list.find(c => c.item === 'shield');
        assert.equal(shield.missing, 1);
        const food = list.find(c => c.item === 'food_any');
        assert.equal(food.missing, 0);
        assert.ok(EXPEDITION_KITS.caving.some(c => c.item === 'water_bucket'));
    });

    it('environment planner gives situational advice', () => {
        const advice = planForEnvironment({ isNight: true, underground: false, light: 4, riskLevel: 'high' });
        assert.ok(advice.some(a => a.includes('Night')));
        assert.ok(advice.some(a => a.includes('Danger')));
        const nether = planForEnvironment({ dimension: 'the_nether' });
        assert.ok(nether.some(a => a.includes('Nether')));
        assert.deepEqual(planForEnvironment({}), []);
    });

    it('environmentContext tolerates a bare bot', () => {
        const ctx = environmentContext({});
        assert.equal(ctx.raining, false);
        assert.equal(ctx.biome, null);
    });
});

describe('resource reservations', () => {
    const dir = path.join('bots', 'SweepReserveTmp');
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ } });

    it('reserve/list/release/available behave consistently', () => {
        const reg = new ResourceReservations({ botName: 'SweepReserveTmp', dir: 'bots' });
        const r1 = reg.reserve('iron_ingot', 16, 'bridge-project');
        assert.equal(r1.ok, true);
        reg.reserve('iron_ingot', 4, 'bridge-project'); // merges
        assert.equal(reg.reserved('iron_ingot'), 20);
        assert.equal(reg.available('iron_ingot', 30), 10);
        assert.equal(reg.available('iron_ingot', 30, { exceptHolder: 'bridge-project' }), 30);
        assert.equal(reg.release('iron_ingot', 'bridge-project', 5), 5);
        assert.equal(reg.reserved('iron_ingot'), 15);
        assert.equal(reg.list().length, 1);
        assert.equal(reg.reserve('x', 0).ok, false, 'zero quantity refused');
    });

    it('reservations expire via TTL', () => {
        let t = 1_000_000;
        const reg = new ResourceReservations({ botName: 'SweepReserveTmp', dir: 'bots', now: () => t, ttlMs: 5000 });
        reg.reserve('gold_ingot', 3, 'holder');
        assert.equal(reg.reserved('gold_ingot'), 3);
        t += 6000;
        assert.equal(reg.reserved('gold_ingot'), 0);
    });

    it('persists and reloads', () => {
        const a = new ResourceReservations({ botName: 'SweepReserveTmp', dir: 'bots' });
        a.reserve('diamond', 2, 'vault');
        const b = new ResourceReservations({ botName: 'SweepReserveTmp', dir: 'bots' });
        assert.equal(b.reserved('diamond'), 2);
    });
});

describe('region/chunk indexing', () => {
    const facts = [
        { pos: { x: 10, z: 10 }, name: 'near' },
        { pos: { x: 1000, z: -1000 }, name: 'far' },
        { name: 'no-position' }
    ];

    it('chunk keys bucket positions into 16x16 columns', () => {
        assert.equal(chunkKeyOf(10, 10), chunkKeyOf(15, 15), 'same 16x16 column');
        assert.notEqual(chunkKeyOf(10, 10), chunkKeyOf(16, 16), 'next column over');
        assert.notEqual(chunkKeyOf(10, 10), chunkKeyOf(40, 40));
    });

    it('factsNear returns only local facts, sorted', () => {
        const idx = buildChunkIndex(facts);
        assert.equal(idx.size, 2, 'positionless facts are skipped');
        const near = factsNear(idx, 12, 12, { radiusChunks: 1 });
        assert.equal(near.length, 1);
        assert.equal(near[0].fact.name, 'near');
        assert.ok(indexSummary(idx).includes('2 chunk region'));
    });
});

describe('global pause / cancel', () => {
    it('pause is idempotent, resume restores', () => {
        const agent = {
            autonomy: { setRuntimeEnabled(on) { this.last = on; } },
            self_prompter: { stop() { this.stopped = true; } }
        };
        assert.equal(pauseAll(agent), true);
        assert.equal(pauseAll(agent), true, 'idempotent');
        assert.equal(agent._paused, true);
        assert.equal(agent.autonomy.last, false);
        assert.equal(agent.self_prompter.stopped, true);
        assert.ok(pauseStatus(agent).startsWith('PAUSED'));
        assert.equal(resumeAll(agent), true);
        assert.equal(agent._paused, false);
        assert.equal(agent.autonomy.last, null, 'back to settings-driven');
        assert.equal(pauseStatus(agent), 'not paused');
        assert.equal(resumeAll(agent), false, 'resume without pause is a no-op');
    });

    it('cancel with reason stops actions and remembers why', async () => {
        let stopped = false;
        const agent = {
            actions: {
                currentActionLabel: 'action:mineBlocks',
                stop: async () => { stopped = true; },
                cancelResume: () => {}
            },
            clearBotLogs: () => {},
            bot: { emit: () => {} }
        };
        const msg = await cancelWithReason(agent, 'we need the wood');
        assert.equal(stopped, true);
        assert.ok(msg.includes('we need the wood'));
        assert.equal(agent._last_cancel.was, 'action:mineBlocks');
    });
});

describe('risky-action confirmation gate', () => {
    const savedConfirm = settings.confirm_risky_actions;
    after(() => { settings.confirm_risky_actions = savedConfirm; });

    it('gate is disabled by default and everything passes', () => {
        assert.equal(confirmGateEnabled(), false);
        assert.equal(checkConfirmation({}, 'alice', '!digDown').proceed, true);
    });

    it('enabled: risky command needs confirm, non-risky passes', () => {
        settings.confirm_risky_actions = true;
        const agent = {};
        const first = checkConfirmation(agent, 'alice', '!digDown', '');
        assert.equal(first.proceed, false);
        assert.ok(first.ask.includes('confirm'));
        assert.equal(checkConfirmation(agent, 'alice', '!inventory').proceed, true, 'queries never gated');
        // inline confirm passes immediately
        assert.equal(checkConfirmation(agent, 'bob', '!attack', 'attack the zombie confirm').proceed, true);
        // alice's pending confirm resolves once
        const pending = consumeConfirmation(agent, 'alice');
        assert.equal(pending, '!digDown');
        assert.equal(consumeConfirmation(agent, 'alice'), null, 'consumed');
        assert.equal(checkConfirmation(agent, 'alice', '!digDown', '').proceed, false, 'needs a fresh confirm');
        settings.confirm_risky_actions = false;
    });

    it('risky set covers the destructive/dangerous commands', () => {
        assert.ok(RISKY_ACTIONS.has('!digDown'));
        assert.ok(RISKY_ACTIONS.has('!enterCave'));
        assert.ok(!RISKY_ACTIONS.has('!inventory'));
    });
});
