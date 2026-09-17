/**
 * sweep_systems.test.js — reliability + intelligence sweep: structured
 * logs, error taxonomy, crash guard, LLM fallback chain, per-world config,
 * store adapters, planning analysis/priorities/checkpoints, player movement
 * history, scheduled tasks, mining helpers, exploration chunk notes, mental
 * map preferences, and synchronous recall with uncertainty flags.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { StructuredLogger, classifyError } from '../src/agent/library/structlog.js';
import { detectPreviousCrash, touchHeartbeat, markCleanShutdown, autonomyBackoffMs, crashGuardStatus } from '../src/agent/library/crash_guard.js';
import { wrapModelWithFallbacks, isTransientProviderError } from '../src/models/model_fallback.js';
import { deepMerge, worldSettings } from '../src/agent/library/world_config.js';
import { WorldModelStore, JSONFileAdapter } from '../src/agent/world_model/store.js';
import { WorldModel } from '../src/agent/world_model/world_model.js';
import { dependencyGraph, resourceGaps, timeAwareness, stepConfidence, summarizeProject, PRIORITY_WEIGHT } from '../src/agent/planning/analysis.js';
import { Project, PlanStep, ProjectStore, STEP } from '../src/agent/planning/project.js';
import { PlayerLedger } from '../src/agent/social/player_ledger.js';
import { scheduledMatches } from '../src/agent/autonomy/task_loop.js';
import { orePriorityRank, orePriorityList, digIsSafe, inventoryNearlyFull } from '../src/agent/baritone/baritone.js';
import { ExplorationState } from '../src/agent/navigation/exploration.js';
import { MentalMap } from '../src/agent/memory/mental_map.js';
import { recallSync, uncertaintyFlags, recallSummary } from '../src/agent/memory/recall.js';
import settings from '../settings.js';

const TMP = path.join('bots', 'SweepSysTmp');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ } });

describe('structured logging + error taxonomy', () => {
    it('appends JSONL events, filters categories, and tails', () => {
        const logger = new StructuredLogger({ botName: 'SweepSysTmp', dir: 'bots' });
        assert.equal(logger.log('navigation', 'route_ok', { profile: 'safe' }), true);
        assert.equal(logger.log('error', 'dig', { message: 'x' }), true);
        const all = logger.tail(10);
        assert.ok(all.length >= 2);
        const navOnly = logger.tail(10, { category: 'navigation' });
        assert.ok(navOnly.every(e => e.category === 'navigation'));
        assert.ok(logger.summarize(5).includes('[navigation] route_ok'));
    });

    it('respects the category allowlist and disabled flag', () => {
        const logger = new StructuredLogger({ botName: 'SweepSysTmp', dir: 'bots', categories: ['error'] });
        assert.equal(logger.log('navigation', 'x'), false);
        assert.equal(logger.log('error', 'y'), true);
        const off = new StructuredLogger({ botName: 'SweepSysTmp', dir: 'bots', enabled: false });
        assert.equal(off.log('error', 'z'), false);
    });

    it('classifies errors into a coarse taxonomy', () => {
        assert.equal(classifyError(new Error('fetch failed')), 'network');
        assert.equal(classifyError(new Error('operation timed out')), 'timeout');
        assert.equal(classifyError(new Error('rate limit exceeded 429')), 'provider');
        assert.equal(classifyError(new Error('no such item found')), 'resource');
        assert.equal(classifyError(new Error('action interrupted')), 'interrupt');
        assert.equal(classifyError(new Error('mystery')), 'unknown');
    });
});

describe('crash guard', () => {
    const name = 'SweepSysTmp';
    it('fresh start: no crash, then heartbeat + clean shutdown resets', () => {
        const first = detectPreviousCrash(name, { dir: 'bots' });
        assert.equal(first.crashed, false);
        touchHeartbeat(name, { dir: 'bots' });
        markCleanShutdown(name, { dir: 'bots' });
        const second = detectPreviousCrash(name, { dir: 'bots' });
        assert.equal(second.crashed, false, 'clean shutdown leaves no crash');
        // the new session resets the flag; streak must be 0 though
        assert.ok(crashGuardStatus(name, { dir: 'bots' }).includes('streak 0'));
    });

    it('dirty shutdown is detected as a crash with escalating backoff', () => {
        touchHeartbeat(name, { dir: 'bots' });
        // no clean shutdown -> crash
        const res = detectPreviousCrash(name, { dir: 'bots' });
        assert.equal(res.crashed, true);
        assert.ok(res.streak >= 1);
        assert.ok(res.backoffMs >= 30000);
        const again = detectPreviousCrash(name, { dir: 'bots' });
        assert.ok(again.streak > res.streak, 'streak escalates');
        assert.ok(autonomyBackoffMs(again.streak) >= res.backoffMs);
        assert.ok(autonomyBackoffMs(50) <= 5 * 60000, 'backoff capped at 5 minutes');
        markCleanShutdown(name, { dir: 'bots' }); // reset for other tests
    });
});

describe('LLM fallback chain', () => {
    it('classifies transient provider errors', () => {
        assert.equal(isTransientProviderError(new Error('fetch failed')), true);
        assert.equal(isTransientProviderError(new Error('429 rate limit')), true);
        assert.equal(isTransientProviderError(new Error('invalid api key')), false);
    });

    it('fails over on transient errors and sticks with the working model', async () => {
        const calls = [];
        const primary = { name: 'primary', prompt: async () => { calls.push('primary'); throw new Error('503 server error'); } };
        const backup = { name: 'backup', prompt: async (msgs) => { calls.push('backup'); return `ok:${msgs.length}`; } };
        const wrapped = wrapModelWithFallbacks(primary, () => [backup], {});
        const res = await wrapped.prompt([1, 2]);
        assert.equal(res, 'ok:2');
        assert.deepEqual(calls, ['primary', 'backup']);
        // subsequent calls go straight to the backup
        await wrapped.prompt([1]);
        assert.deepEqual(calls, ['primary', 'backup', 'backup']);
        // non-prompt properties forward to the current model
        assert.equal(wrapped.name, 'backup');
    });

    it('does not fail over on validation errors', async () => {
        const backup = { prompt: async () => 'never' };
        const primary = { prompt: async () => { throw new Error('invalid api key'); } };
        const wrapped = wrapModelWithFallbacks(primary, () => [backup], {});
        await assert.rejects(() => wrapped.prompt([]), /invalid api key/);
    });
});

describe('per-world configuration', () => {
    it('deep-merges nested overrides without mutating base', () => {
        const base = { a: { x: 1, y: 2 }, b: [1, 2] };
        const merged = deepMerge(base, { a: { y: 3, z: 4 }, b: [9] });
        assert.deepEqual(merged.a, { x: 1, y: 3, z: 4 });
        assert.deepEqual(merged.b, [9], 'arrays replace');
        assert.deepEqual(base.a, { x: 1, y: 2 }, 'base untouched');
    });

    it('applies host-matched and any-world overrides', () => {
        const saved = settings.worlds;
        settings.worlds = {
            any: { autonomy: { history_limit: 7 } },
            '127.0.0.1': { autonomy: { history_limit: 3 } }
        };
        try {
            const s = worldSettings({ bot: { host: '127.0.0.1' } });
            assert.equal(s.autonomy.history_limit, 3, 'host override wins over any');
            const other = worldSettings({ bot: { host: 'elsewhere.example' } });
            assert.equal(other.autonomy.history_limit, 7, 'any applies elsewhere');
        } finally {
            settings.worlds = saved;
        }
    });
});

describe('database-backed world model adapter', () => {
    it('JSON adapter round-trips through the store', () => {
        const store = new WorldModelStore('SweepSysTmp', 'bots');
        const model = new WorldModel();
        model.record('location', { name: 'test-place', pos: { x: 1, y: 2, z: 3 } });
        assert.equal(store.save(model, { force: true }), true);
        const loaded = store.load();
        assert.ok(loaded.all('location').some(f => f.name === 'test-place'));
        store.clear();
    });

    it('a custom adapter can replace the file backend entirely', () => {
        const mem = { data: null };
        const adapter = {
            read: () => mem.data,
            write: (json) => { mem.data = json; return true; },
            remove: () => { mem.data = null; return true; }
        };
        const store = new WorldModelStore('SweepSysTmp', 'bots', { adapter });
        const model = new WorldModel();
        model.record('resource', { name: 'diamond_ore', pos: { x: 9, y: 9, z: 9 } });
        store.save(model, { force: true });
        const loaded = store.load();
        assert.ok(loaded.all('resource').some(f => f.name === 'diamond_ore'));
        assert.ok(mem.data, 'data went through the adapter, not the file');
    });
});

describe('planning analysis', () => {
    function makeProject() {
        const a = new PlanStep({ id: 'a', title: 'gather 10 cobblestone' });
        const b = new PlanStep({ id: 'b', title: 'craft stone bricks', dependsOn: ['a'], attempts: 3, criticNote: 'still missing materials' });
        const c = new PlanStep({ id: 'c', title: 'build the wall', dependsOn: ['b'] });
        a.status = STEP.DONE; a.startedAt = 1000; a.finishedAt = 46000;
        return new Project({ goal: 'build a wall', steps: [a, b, c] });
    }

    it('builds the dependency graph with levels and validates it', () => {
        const g = dependencyGraph(makeProject());
        assert.equal(g.nodes.length, 3);
        assert.equal(g.edges.length, 2);
        assert.equal(g.valid, true);
        assert.equal(g.levels.a, 0);
        assert.equal(g.levels.c, 2);
        assert.deepEqual(g.cycles, []);
    });

    it('detects dangling dependencies and cycles', () => {
        const p = makeProject();
        p.steps[2].dependsOn = ['ghost'];
        assert.equal(dependencyGraph(p).valid, false);
        const q = new Project({ goal: 'cycle', steps: [
            new PlanStep({ id: 'x', title: 'x', dependsOn: ['y'] }),
            new PlanStep({ id: 'y', title: 'y', dependsOn: ['x'] })
        ]});
        const gq = dependencyGraph(q);
        assert.equal(gq.valid, false);
        assert.equal(gq.cycles.length, 2);
    });

    it('resource gaps: mentioned items we do not carry', () => {
        const gaps = resourceGaps(makeProject(), { cobblestone: 64 });
        assert.ok(!gaps.some(g => g.item === 'cobblestone'), 'we carry cobblestone');
        assert.ok(gaps.some(g => g.item === 'stone'), 'mentions stone bricks ingredient? at least flags unknowns');
    });

    it('time awareness estimates duration and night crossing', () => {
        const t = timeAwareness(makeProject(), { timeOfDay: 12800, nightAt: 13000 });
        assert.equal(t.remainingSteps, 2);
        assert.ok(t.estimateS > 0);
        assert.equal(t.crossesNight, true, '100 ticks to night, plan takes minutes');
        assert.ok(t.note.includes('night'));
        const day = timeAwareness(makeProject(), { timeOfDay: 1000 });
        assert.equal(day.crossesNight, false);
    });

    it('step confidence drops with attempts and criticism', () => {
        const p = makeProject();
        const done = stepConfidence(p.getStep('a'));
        const struggling = stepConfidence(p.getStep('b'));
        assert.ok(done > struggling, `done ${done} > struggling ${struggling}`);
        assert.ok(struggling >= 0.2 && struggling <= 1);
    });

    it('natural-language summary covers progress and next step', () => {
        const s = summarizeProject(makeProject());
        assert.ok(s.includes('1/3 steps done'));
        assert.ok(s.includes('Next up'));
        assert.equal(summarizeProject(null), 'No active plan.');
    });

    it('priority handling: urgent steps jump the queue', () => {
        const bg = new PlanStep({ id: 'bg', title: 'background chore', priority: 'background' });
        const urgent = new PlanStep({ id: 'u', title: 'urgent fix', priority: 'urgent' });
        const normal = new PlanStep({ id: 'n', title: 'normal task' });
        const p = new Project({ goal: 'prio', steps: [bg, urgent, normal] });
        assert.equal(p.nextStep().id, 'u', 'urgent runs first');
        assert.ok(PRIORITY_WEIGHT.urgent < PRIORITY_WEIGHT.normal && PRIORITY_WEIGHT.normal < PRIORITY_WEIGHT.background);
        // priority survives serialization
        const round = new Project(p.toJSON ? p.toJSON() : JSON.parse(JSON.stringify(p)));
        assert.equal(round.getStep('u').priority, 'urgent');
    });

    it('plan checkpoints persist and load', () => {
        const store = new ProjectStore('SweepSysTmp', 'bots');
        store.saveCheckpoint({ projectId: 'p1', goal: 'x', stepsDone: 2, stepsTotal: 5, updatedAt: Date.now() });
        const cp = store.loadCheckpoint();
        assert.equal(cp.stepsDone, 2);
        assert.equal(cp.projectId, 'p1');
        store.clear();
        assert.equal(store.loadCheckpoint(), null, 'cleared with the project');
    });
});

describe('player movement history', () => {
    it('records a bounded, deduped position ring and derives heading', () => {
        const ledger = new PlayerLedger({ botName: 'SweepSysTmp', dir: 'bots' });
        ledger.sight('alice', { dist: 5, pos: { x: 0, z: 0 } });
        ledger.sight('alice', { dist: 5, pos: { x: 0.5, z: 0 } }); // jitter: merged
        ledger.sight('alice', { dist: 6, pos: { x: 4, z: 0 } });
        ledger.sight('alice', { dist: 7, pos: { x: 8, z: 0 } });
        const hist = ledger.movementHistory('alice');
        assert.equal(hist.length, 3, 'jitter merged, real moves kept');
        assert.equal(ledger.heading('alice'), 0, 'moving +x = 0 degrees');
        for (let i = 0; i < 30; i++) ledger.sight('alice', { pos: { x: 10 + i * 3, z: 0 } });
        assert.ok(ledger.movementHistory('alice').length <= 16, 'ring is bounded');
    });
});

describe('scheduled tasks', () => {
    it('dawn/dusk/clock matching with mc-time windows', () => {
        assert.equal(scheduledMatches({ at: 'dawn', do: 'farm' }, 0), true);
        assert.equal(scheduledMatches({ at: 'dawn', do: 'farm' }, 23900), true);
        assert.equal(scheduledMatches({ at: 'dawn', do: 'farm' }, 12000), false);
        assert.equal(scheduledMatches({ at: 'dusk', do: 'rest' }, 13000), true);
        assert.equal(scheduledMatches({ at: '06:00', do: 'farm' }, 6000), true, '06:00 ~ mc 6000');
        assert.equal(scheduledMatches({ at: 'garbage', do: 'x' }, 0), false);
        assert.equal(scheduledMatches(null, 0), false);
    });
});

describe('mining helpers', () => {
    it('ore priority ranks configured ores before unknowns', () => {
        const list = orePriorityList();
        assert.ok(list.indexOf('diamond_ore') < list.indexOf('coal_ore'));
        assert.ok(orePriorityRank('diamond_ore') < orePriorityRank('coal_ore'));
        assert.equal(orePriorityRank('mystery_block'), 999);
        assert.ok(Array.isArray(settings.resources.priority), 'priority comes from settings');
    });

    it('dig probe refuses blocks adjacent to lava', () => {
        const bot = {
            blockAt: (p) => (p.x === 11 ? { name: 'lava' } : { name: 'iron_ore' })
        };
        const unsafe = digIsSafe(bot, { position: { x: 10, y: 20, z: 20 } });
        assert.equal(unsafe.safe, false);
        assert.ok(unsafe.reason.includes('lava'));
        const safe = digIsSafe(bot, { position: { x: 50, y: 20, z: 20 } });
        assert.equal(safe.safe, true);
        // probing must never throw
        assert.equal(digIsSafe({}, {}).safe, true);
    });

    it('inventory-full detection counts main+hotbar slots', () => {
        const slots = new Array(46).fill(null);
        for (let i = 9; i < 45; i++) slots[i] = { name: 'cobblestone', count: 64 };
        assert.equal(inventoryNearlyFull({ inventory: { slots } }, { minFree: 1 }), true);
        slots[44] = null;
        assert.equal(inventoryNearlyFull({ inventory: { slots } }, { minFree: 1 }), false);
        assert.equal(inventoryNearlyFull({ inventory: { slots } }, { minFree: 2 }), true);
    });
});

describe('exploration chunk notes + mental map preferences', () => {
    it('chunk notes persist with the exploration state', () => {
        const st = new ExplorationState();
        st.setChunkNote(10, 10, 'plains');
        assert.equal(st.chunkNote(10, 10), 'plains');
        const round = ExplorationState.fromJSON(JSON.parse(JSON.stringify(st.toJSON())));
        assert.equal(round.chunkNote(10, 10), 'plains');
        for (let i = 0; i < 600; i++) st.setChunkNote(i * 16, 0, `biome${i}`);
        assert.ok(st.notes.size <= 512, 'notes bounded');
    });

    it('bumpVisit tracks favorites', () => {
        const map = new MentalMap({ botName: 'SweepSysMap', dir: 'bots' });
        map.note({ x: 1, y: 2, z: 3 }, { name: 'forge', type: 'base' });
        map.note({ x: 9, y: 2, z: 9 }, { name: 'garden', type: 'farm' });
        map.bumpVisit('forge');
        map.bumpVisit('forge');
        map.bumpVisit('garden');
        const favs = map.favorites();
        assert.equal(favs[0].name, 'forge');
        assert.equal(favs[0].visits, 2);
        try { fs.rmSync(path.join('bots', 'SweepSysMap'), { recursive: true, force: true }); } catch { /* ok */ }
    });
});

describe('synchronous recall + explicit uncertainty', () => {
    it('recallSync ranks keyword matches without embedding', () => {
        const map = new MentalMap({ botName: 'SweepSysRecall', dir: 'bots' });
        const agent = { bot: { username: 'SweepSysRecall', entity: { position: { x: 0, y: 64, z: 0 } } }, _mental_map: map };
        map.note({ x: 100, y: 64, z: 100 }, { name: 'village east', type: 'village' });
        map.note({ x: 5, y: 64, z: 5 }, { name: 'home base', type: 'base' });
        const hits = recallSync(agent, 'village', { limit: 3 });
        assert.ok(hits.length >= 1);
        assert.equal(hits[0].name, 'village east');
        try { fs.rmSync(path.join('bots', 'SweepSysRecall'), { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('uncertainty flags hit far and positionless memories', () => {
        const hits = [
            { name: 'near', x: 1, z: 1, distance: 2 },
            { name: 'far', x: 500, z: 500, distance: 700 },
            { name: 'nowhere', x: null, z: null, distance: null }
        ];
        const flags = uncertaintyFlags(hits);
        assert.equal(flags.length, 2);
        assert.ok(flags.some(f => f.name === 'nowhere' && f.reason.includes('no known position')));
        assert.ok(flags.some(f => f.name === 'far'));
    });

    it('recall summary voices the uncertainty', () => {
        const summary = recallSummary('x', [{ kind: 'poi', name: 'far spot', x: 1, y: 2, z: 3, distance: 300 }]);
        assert.ok(summary.includes('uncertain'));
    });
});
