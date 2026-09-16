import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    chooseIdleAction,
    runIdleAction,
    inspectInventory,
    checkSurroundings,
    shortWander,
    getIdleConfig
} from '../src/agent/humanlike/idle.js';
import { createPersonality } from '../src/agent/humanlike/personality.js';
import { IDLE_ACTIONS } from '../src/agent/humanlike/idle.js';

function makeCtx(over = {}) {
    return {
        idleForMs: 30000,
        state: 'idle',
        recentDanger: false,
        novelSights: [],
        ...over
    };
}

describe('humanlike idle selection', () => {
    it('always picks a known action', () => {
        const p = createPersonality({ name: 'Idler' });
        for (let i = 0; i < 100; i++) {
            const choice = chooseIdleAction(makeCtx(), p);
            assert.ok(IDLE_ACTIONS.includes(choice.action), `unknown action ${choice.action}`);
            assert.ok(choice.reason);
        }
    });

    it('is reproducible for the same seed and context', () => {
        const p1 = createPersonality({ name: 'Twin' });
        const p2 = createPersonality({ name: 'Twin' });
        for (let i = 0; i < 30; i++) {
            const c1 = chooseIdleAction(makeCtx({ idleForMs: 20000 + i * 1000 }), p1);
            const c2 = chooseIdleAction(makeCtx({ idleForMs: 20000 + i * 1000 }), p2);
            assert.equal(c1.action, c2.action);
        }
    });

    it('danger or reactive states force a pause', () => {
        const p = createPersonality({ name: 'Scared' });
        for (const state of ['react', 'interrupted', 'recover']) {
            const choice = chooseIdleAction(makeCtx({ state }), p);
            assert.equal(choice.action, 'pause', `state ${state}`);
        }
        const dangerChoice = chooseIdleAction(makeCtx({ recentDanger: true, state: 'idle' }), p);
        assert.equal(dangerChoice.action, 'pause');
        assert.equal(dangerChoice.reason, 'danger');
    });

    it('settles instead of acting right after work', () => {
        const p = createPersonality({ name: 'Settler' });
        const choice = chooseIdleAction(makeCtx({ idleForMs: 1000 }), p);
        assert.equal(choice.action, 'pause');
        assert.equal(choice.reason, 'settling');
    });

    it('never wanders when restlessness is zero', () => {
        const p = createPersonality({ name: 'Homebody', overrides: { restlessness: 0 } });
        for (let i = 0; i < 200; i++) {
            const choice = chooseIdleAction(makeCtx({ idleForMs: 60000 }), p);
            assert.notEqual(choice.action, 'wander');
        }
    });

    it('novel sights get glances at least sometimes', () => {
        const p = createPersonality({ name: 'Nosy', overrides: { curiosity: 1 } });
        let glances = 0;
        for (let i = 0; i < 100; i++) {
            const ctx = makeCtx({
                idleForMs: 2000,
                novelSights: [{ kind: 'player', pos: { x: 3, y: 64, z: 3 }, dist: 4 }]
            });
            const choice = chooseIdleAction(ctx, p);
            if (choice.action === 'glance') {
                glances++;
                assert.deepEqual(choice.target, { x: 3, y: 64, z: 3 });
            }
        }
        assert.ok(glances > 40, `curious bot should glance often (got ${glances}/100)`);
    });
});

describe('humanlike idle execution', () => {
    function idleBot() {
        const looks = [];
        return {
            looks,
            entity: { position: new Vec3(0, 64, 0), yaw: 0.5, pitch: 0 },
            look: async (yaw, pitch, force) => { looks.push({ yaw, pitch, force }); },
            blockAt: (pos) => {
                const y = Math.floor(pos.y);
                if (y === 63) return { name: 'grass_block', boundingBox: 'block' };
                return { name: 'air', boundingBox: 'empty' };
            },
            pathfinderGoals: [],
            pathfinder: { setGoal(goal) { this.goals = this.goals || []; this.goals.push(goal); } },
            interrupt_code: null
        };
    }

    it('inspectInventory looks down and back', async () => {
        const bot = idleBot();
        const p = createPersonality({ name: 'Checker', overrides: { pace: 0.6 } });
        await inspectInventory(bot, p);
        assert.ok(bot.looks.length >= 2);
        assert.ok(bot.looks[0].pitch > 1, 'should look down');
        const last = bot.looks[bot.looks.length - 1];
        assert.ok(Math.abs(last.pitch - 0) < 0.01, 'should return to original pitch');
    });

    it('checkSurroundings sweeps and returns to start', async () => {
        const bot = idleBot();
        const p = createPersonality({ name: 'Sweeper', overrides: { pace: 0.6 } });
        const ok = await checkSurroundings(bot, p);
        assert.equal(ok, true);
        assert.ok(bot.looks.length >= 3);
        const last = bot.looks[bot.looks.length - 1];
        assert.ok(Math.abs(last.yaw - 0.5) < 0.01);
    });

    it('shortWander refuses when no safe spot exists', async () => {
        const bot = idleBot();
        bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' }); // no solid ground anywhere
        const p = createPersonality({ name: 'Nowhere' });
        const ok = await shortWander(bot, p, { radius: 3 });
        assert.equal(ok, false);
        assert.equal((bot.pathfinder.goals || []).length, 0);
    });

    it('shortWander refuses hazard spots', async () => {
        const bot = idleBot();
        bot.blockAt = (pos) => {
            const y = Math.floor(pos.y);
            if (y === 63) return { name: 'lava', boundingBox: 'empty' };
            return { name: 'air', boundingBox: 'empty' };
        };
        const p = createPersonality({ name: 'Lava' });
        assert.equal(await shortWander(bot, p, { radius: 3 }), false);
    });

    it('shortWander walks to a safe spot and clears its goal', async () => {
        const bot = idleBot();
        // teleport-arrive whenever a goal is set, simulating instant pathfinding
        bot.pathfinder.setGoal = function (goal) {
            this.goals = this.goals || [];
            this.goals.push(goal);
            if (goal && typeof goal.x === 'number') {
                bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
            }
        };
        const p = createPersonality({ name: 'Stroller', overrides: { pace: 0.6, restlessness: 0.8 } });
        const ok = await shortWander(bot, p, { radius: 2 });
        assert.equal(ok, true);
        const goals = bot.pathfinder.goals;
        assert.ok(goals.length >= 1);
        assert.equal(goals[goals.length - 1], null, 'goal must be cleared afterwards');
    });

    it('runIdleAction dispatches glances and pauses', async () => {
        const bot = idleBot();
        const p = createPersonality({ name: 'Dispatch', overrides: { pace: 0.6 } });
        const r1 = await runIdleAction(bot, { action: 'glance', target: { x: 2, y: 64, z: 2 } }, p);
        assert.equal(r1.action, 'glance');
        assert.equal(bot.looks.length, 1);
        const r2 = await runIdleAction(bot, { action: 'pause' }, p);
        assert.equal(r2.action, 'pause');
        assert.ok(r2.ms >= 150);
        const r3 = await runIdleAction(bot, null, p);
        assert.equal(r3.action, 'none');
    });

    it('idle config honors bounds', () => {
        const cfg = getIdleConfig();
        assert.ok(cfg.radius >= 1 && cfg.radius <= 8);
        assert.ok(cfg.min_idle_ms >= 0);
        assert.equal(typeof cfg.wander, 'boolean');
    });
});
