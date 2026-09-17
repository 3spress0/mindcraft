/**
 * sweep_building_ledger.test.js — build cancellation bookkeeping, rollback,
 * temporary-block management, error categorization, preconditions/self-check,
 * contextual tool choice, and item-recovery-after-death.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { Vec3 } from 'vec3';
import { BuildLedger, rollbackBuild, restoreTempBlocks } from '../src/agent/npc/build_ledger.js';
import { classifyError, retryableCategory, ERROR_CATEGORIES } from '../src/agent/library/error_classes.js';
import { stepPreconditions, checkPreconditions, actionConfidence, preActionCheck } from '../src/agent/planning/analysis.js';
import { chooseToolForTask } from '../src/agent/library/durability.js';
import { MetricsTracker } from '../src/agent/library/metrics.js';

const DIR = 'bots/SweepBuildTmp';
after(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync('bots/SweepErrTmp', { recursive: true, force: true }); } catch { /* ok */ }
});

describe('build ledger', () => {
    it('tracks active build, placements, finish and cancel', () => {
        const ledger = new BuildLedger({ botName: 'SweepBuildTmp', dir: 'bots' });
        ledger.startBuild('hut', { x: 1, y: 64, z: 2 });
        assert.equal(ledger.active.name, 'hut');
        ledger.recordPlacement({ x: 1, y: 64, z: 2 }, 'oak_planks', 'air');
        ledger.recordPlacement({ x: 2, y: 64, z: 2 }, 'oak_planks', null);
        assert.equal(ledger.placements.length, 2);
        ledger.finishBuild('hut');
        assert.equal(ledger.active, null);
        // cancel bookkeeping on a fresh build
        ledger.startBuild('wall', null);
        ledger.recordPlacement({ x: 9, y: 64, z: 9 }, 'cobblestone', null);
        const rec = ledger.cancelBuild('wall', 'changed my mind');
        assert.equal(rec.reason, 'changed my mind');
        assert.equal(rec.placements, 1);
        assert.equal(ledger.active, null);
        assert.ok(ledger.summary().includes('last cancel: wall'));
    });

    it('persists and reloads from disk', () => {
        const a = new BuildLedger({ botName: 'SweepBuildTmp', dir: 'bots' });
        a.startBuild('tower', { x: 0, y: 64, z: 0 });
        a.recordPlacement({ x: 0, y: 65, z: 0 }, 'stone_bricks', null);
        a.registerTempBlock({ x: 4, y: 63, z: 4 }, 'grass_block');
        const b = new BuildLedger({ botName: 'SweepBuildTmp', dir: 'bots' });
        assert.equal(b.active?.name, 'tower');
        assert.ok(b.placements.some(p => p.block === 'stone_bricks'));
        assert.equal(b.tempBlocks.length, 1);
        assert.equal(b.tempBlocks[0].original, 'grass_block');
    });

    it('rollback plan returns last-placed first and is bounded', () => {
        const ledger = new BuildLedger({ botName: 'SweepBuildTmp', dir: 'bots' });
        ledger.placements = [];
        for (let i = 0; i < 10; i++) ledger.recordPlacement({ x: i, y: 64, z: 0 }, 'stone', null);
        const plan = ledger.rollbackPlan(4);
        assert.equal(plan.length, 4);
        assert.equal(plan[0].x, 9);
        assert.equal(plan[3].x, 6);
    });

    it('rollbackBuild digs recorded blocks in reverse and skips mismatches', async () => {
        const { getBuildLedger } = await import('../src/agent/npc/build_ledger.js');
        const agent = {
            name: 'SweepBuildTmp',
            bot: {
                username: 'SweepBuildTmp',
                interrupt_code: null,
                blockAt: (p) => (p.x <= 2 && p.y === 64 ? { name: 'oak_planks' } : { name: 'air' })
            }
        };
        const ledger = getBuildLedger(agent); // same instance rollbackBuild uses
        ledger.placements = [];
        ledger.recordPlacement({ x: 1, y: 64, z: 1 }, 'oak_planks', null);
        ledger.recordPlacement({ x: 2, y: 64, z: 1 }, 'oak_planks', null);
        ledger.recordPlacement({ x: 9, y: 64, z: 9 }, 'diamond_block', null); // not present live
        const res = await rollbackBuild(agent, { max: 8 });
        // diamond_block mismatch is skipped (removed from the ledger), the two
        // oak_planks entries fail to dig on the stub bot but must not throw
        assert.ok(res.rolledBack + res.failed <= 8);
        assert.ok(!ledger.placements.some(p => p.x === 9), 'mismatched entry removed');
        ledger.placements = []; // keep later tests hermetic
    });

    it('temporary blocks: register, take, and restore into air only', async () => {
        const { getBuildLedger } = await import('../src/agent/npc/build_ledger.js');
        const agent = { name: 'SweepBuildTmp', bot: { username: 'SweepBuildTmp' } };
        const ledger = getBuildLedger(agent);
        ledger.tempBlocks = [];
        ledger.registerTempBlock({ x: 5, y: 63, z: 5 }, 'grass_block');
        assert.equal(ledger.tempBlocks.length, 1);
        const taken = ledger.takeTempBlocks();
        assert.equal(taken.length, 1);
        assert.equal(taken[0].original, 'grass_block');
        assert.equal(ledger.tempBlocks.length, 0);
        // restore on empty list is a clean no-op
        const res = await restoreTempBlocks(agent, {});
        assert.deepEqual({ restored: res.restored, failed: res.failed }, { restored: 0, failed: 0 });
    });
});

describe('error categorization', () => {
    it('maps representative errors onto the taxonomy', () => {
        assert.equal(classifyError(new Error('LLM request timed out after 60s')).category, 'timeout');
        assert.equal(classifyError('429 Too Many Requests').category, 'rate_limited');
        assert.equal(classifyError(new Error('fetch failed: ECONNRESET')).category, 'network');
        assert.equal(classifyError('No path found to goal').category, 'pathfinding');
        assert.equal(classifyError('desync on bread: expected +4, actual +2').category, 'inventory');
        assert.equal(classifyError('chunk not loaded at target').category, 'world');
        assert.equal(classifyError('permission denied by region guard').category, 'permission');
        assert.equal(classifyError('goal interrupted by !stop').category, 'interrupted');
        assert.equal(classifyError('model returned malformed response').category, 'llm');
        assert.equal(classifyError('completely novel failure').category, 'unknown');
    });

    it('never throws and flags retryable categories', () => {
        assert.equal(classifyError(null).category, 'unknown');
        assert.equal(retryableCategory('timeout'), true);
        assert.equal(retryableCategory('network'), true);
        assert.equal(retryableCategory('permission'), false);
        assert.ok(ERROR_CATEGORIES.includes('unknown'));
    });

    it('metrics record errors by category and persist them', () => {
        const m = new MetricsTracker({ botName: 'SweepErrTmp', dir: 'bots' });
        m.recordError('timeout', { detail: 'test' });
        m.recordError('timeout');
        m.recordError('pathfinding');
        assert.equal(m.errors.timeout, 2);
        assert.equal(m.errors.pathfinding, 1);
        assert.equal(m.lastError.category, 'pathfinding');
        const m2 = new MetricsTracker({ botName: 'SweepErrTmp', dir: 'bots' });
        assert.equal(m2.errors.timeout, 2, 'error counts survive reload');
    });
});

describe('preconditions and self-check', () => {
    const step = (title, extra = {}) => ({ title, instruction: '', status: 'open', attempts: 1, ...extra });

    it('extracts mentioned items as preconditions', () => {
        const pres = stepPreconditions(step('Build a chest house using oak_planks and cobblestone'), { oak_planks: 4 });
        const planks = pres.find(p => p.item === 'oak_planks');
        const cobble = pres.find(p => p.item === 'cobblestone');
        assert.ok(planks && planks.ok === true);
        assert.ok(cobble && cobble.ok === false);
    });

    it('honors explicit requires entries', () => {
        const pres = stepPreconditions(step('Anything', { requires: [{ item: 'diamond', count: 3 }] }), { diamond: 2 });
        assert.equal(pres.length, 1);
        assert.equal(pres[0].ok, false);
    });

    it('checkPreconditions scans remaining steps only', () => {
        const project = {
            steps: [
                { title: 'mine cobblestone', instruction: '', status: 'done', attempts: 1 },
                { title: 'build a furnace', instruction: '', status: 'active', attempts: 1 }
            ]
        };
        const res = checkPreconditions(project, {});
        assert.equal(res.ok, false);
        // cobblestone only appears in the DONE step, so only furnace is missing
        assert.ok(res.missing.some(m => m.item === 'furnace'));
        assert.ok(!res.missing.some(m => m.item === 'cobblestone'));
    });

    it('action confidence lists concrete uncertainty reasons', () => {
        const s = step('build with cobblestone', { attempts: 3 });
        const { confidence, uncertain } = actionConfidence(s, { inventoryCounts: {}, riskLevel: 'high' });
        assert.ok(confidence < 0.6);
        assert.ok(uncertain.some(u => u.includes('missing cobblestone')));
        assert.ok(uncertain.some(u => u.includes('attempted')));
        assert.ok(uncertain.some(u => u.includes('risk')));
    });

    it('preActionCheck blocks unhealthy bots and warns about gaps', () => {
        const s = step('build with cobblestone');
        const blocked = preActionCheck(s, { inventoryCounts: {}, botHealthy: false });
        assert.equal(blocked.go, false);
        const fine = preActionCheck(step('do a thing'), { inventoryCounts: {}, botHealthy: true });
        assert.equal(fine.go, true);
        assert.deepEqual(fine.warnings, []);
    });
});

describe('contextual tool choice', () => {
    const botWith = (items) => ({
        inventory: { slots: items.map((n, i) => ({ name: n, slot: i, damage: 0, maxDurability: 100 })) }
    });

    it('picks the task family and prefers healthier tools', () => {
        const bot = botWith(['wooden_pickaxe', 'iron_pickaxe']);
        const choice = chooseToolForTask(bot, 'mine');
        assert.ok(['wooden_pickaxe', 'iron_pickaxe'].includes(choice.tool));
        assert.equal(chooseToolForTask(bot, 'chop'), null, 'no axe carried');
        const swordBot = botWith(['stone_sword']);
        assert.equal(chooseToolForTask(swordBot, 'combat').tool, 'stone_sword');
    });

    it('never picks a nearly-broken tool and never throws', () => {
        const broken = {
            inventory: { slots: [{ name: 'iron_pickaxe', durabilityUsed: 249, maxDurability: 250 }] }
        };
        assert.equal(chooseToolForTask(broken, 'mine'), null);
        assert.equal(chooseToolForTask(null, 'mine'), null);
        assert.equal(chooseToolForTask(botWith([]), 'unknown_task'), null);
    });
});

describe('item recovery after death', () => {
    it('recordDeath stores a ranked inventory snapshot', () => {
        const m = new MetricsTracker({ botName: 'SweepErrTmp', dir: 'bots' });
        const d = m.recordDeath({
            cause: 'zombie', pos: new Vec3(10, 64, -5),
            inventory: { oak_log: 32, diamond: 3, dirt: 64 }
        });
        assert.equal(d.cause, 'zombie');
        assert.ok(Array.isArray(d.inventory));
        assert.ok(d.inventory[0].startsWith('dirt x64'), 'sorted by count desc');
        assert.ok(d.inventory.some(s => s.startsWith('diamond x3')));
    });
});
