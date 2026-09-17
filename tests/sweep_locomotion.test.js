/**
 * sweep_locomotion.test.js — humanlike locomotion layer (natural
 * accel/decel, strafing, sprint-near-obstacles, swim/climb pacing),
 * suffocation detection, persistent block knowledge, entity-vanish tracking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    sprintDecision, strafeGoal, swimDecision, climbDecision,
    hazardsNearCount, climbableAt, attachLocomotion
} from '../src/agent/humanlike/locomotion.js';
import { suffocationState, rememberNotableBlocks, trackVanishedEntities } from '../src/agent/sensors/awareness.js';
import { createRng } from '../src/agent/humanlike/rng.js';

describe('sprint gating (accel/decel + obstacles)', () => {
    it('never sprints at the very start or very end of a run', () => {
        assert.equal(sprintDecision({ distFromStart: 0, distToGoal: 100, hazardsNear: 0, baseSprint: true }), false);
        assert.equal(sprintDecision({ distFromStart: 3, distToGoal: 100, hazardsNear: 0, baseSprint: true }), false);
        assert.equal(sprintDecision({ distFromStart: 30, distToGoal: 2, hazardsNear: 0, baseSprint: true }), false);
    });

    it('sprints mid-route when the way is clear', () => {
        assert.equal(sprintDecision({ distFromStart: 8, distToGoal: 20, hazardsNear: 0, baseSprint: true }), true);
    });

    it('stops sprinting near obstacles', () => {
        assert.equal(sprintDecision({ distFromStart: 8, distToGoal: 20, hazardsNear: 2, baseSprint: true }), false);
    });

    it('respects baseSprint=false', () => {
        assert.equal(sprintDecision({ distFromStart: 8, distToGoal: 20, hazardsNear: 0, baseSprint: false }), false);
    });
});

describe('humanlike strafing', () => {
    it('offsets the goal only when the seeded roll passes', () => {
        const passRng = { chance: () => true, range: () => 1, float: () => 0.1 };
        const failRng = { chance: () => false };
        const goal = { x: 10, z: 10 };
        const offset = strafeGoal(goal, passRng, { chance: 0.25 });
        assert.equal(offset.offset, true);
        assert.ok(Math.abs(offset.x - 10) + Math.abs(offset.z - 10) >= 1, 'offset must move at least one block');
        const same = strafeGoal(goal, failRng, { chance: 0.25 });
        assert.equal(same.offset, false);
        assert.deepEqual({ x: same.x, z: same.z }, goal);
    });

    it('is deterministic for a seeded rng', () => {
        const g = { x: 5, z: 7 };
        const a = strafeGoal(g, createRng('strafe-a'), { chance: 1 });
        const b = strafeGoal(g, createRng('strafe-a'), { chance: 1 });
        assert.deepEqual(a, b);
    });

    it('handles missing rng gracefully', () => {
        const out = strafeGoal({ x: 1, z: 2 }, null);
        assert.equal(out.offset, false);
    });
});

describe('swim and climb decisions', () => {
    it('rises when submerged with low air', () => {
        assert.deepEqual(swimDecision({ headInWater: true, air: 100, maxAir: 300 }), { rise: true, reason: 'air low' });
        assert.equal(swimDecision({ headInWater: true, air: 290, maxAir: 300 }).rise, false);
        assert.equal(swimDecision({ headInWater: false, air: 0, maxAir: 300 }).rise, false);
    });

    it('pauses occasionally mid-climb, never before the min ticks', () => {
        const always = { chance: () => true };
        assert.equal(climbDecision({ onClimbable: true, climbTicks: 4 }, always).pause, false, 'too early');
        assert.equal(climbDecision({ onClimbable: true, climbTicks: 20 }, always).pause, true);
        assert.equal(climbDecision({ onClimbable: false, climbTicks: 100 }, always).pause, false);
    });

    it('climbableAt finds ladders at feet or head', () => {
        const bot = {
            entity: { position: new Vec3(3.5, 64, 3.5) },
            blockAt: (p) => (p.y === 65 ? { name: 'ladder' } : { name: 'air' })
        };
        assert.equal(climbableAt(bot), 'ladder');
        assert.equal(climbableAt({ entity: { position: new Vec3(0, 64, 0) }, blockAt: () => ({ name: 'stone' }) }), null);
    });
});

describe('hazard proximity counting', () => {
    it('counts hazards near a position and never throws', () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            blockAt: (p) => ({ name: Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 && p.y === 63 ? 'lava' : 'air', boundingBox: Math.abs(p.x) <= 1 ? 'block' : 'empty' })
        };
        const n = hazardsNearCount(bot, { x: 0, y: 64, z: 0 }, { radius: 2 });
        assert.ok(n >= 1, `expected hazards near lava, got ${n}`);
        assert.equal(hazardsNearCount(null, { x: 0, y: 64, z: 0 }), 0);
    });
});

describe('attachLocomotion', () => {
    it('attaches once, honors path events, and detaches cleanly', () => {
        const listeners = {};
        const controls = {};
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            air: 300,
            blockAt: () => ({ name: 'air' }),
            on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
            removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] ?? []).filter(f => f !== fn); },
            setControlState: (k, v) => { controls[k] = v; },
            pathfinder: { isMoving: () => false }
        };
        const h1 = attachLocomotion(bot, {});
        const h2 = attachLocomotion(bot, {});
        assert.equal(h1, h2, 'double-attach must return the same handle');
        // path update records the goal; physics tick stays quiet when not moving
        (listeners['path_update'] ?? []).forEach(fn => fn({ goal: { x: 10, y: 64, z: 0 } }));
        (listeners['physicTick'] ?? []).forEach(fn => fn());
        (listeners['goal_reached'] ?? []).forEach(fn => fn());
        h1.detach();
        assert.equal(bot._locomotion_attached, false);
    });

    it('never throws when the bot lacks pathfinder', () => {
        const bot = { entity: { position: new Vec3(0, 64, 0) }, on: () => {}, air: 300, blockAt: () => ({ name: 'air' }) };
        const h = attachLocomotion(bot, {});
        assert.ok(h.detach);
    });
});

describe('suffocation detection', () => {
    it('detects a solid block at head height', () => {
        const bot = {
            entity: { position: new Vec3(5.5, 64, 5.5) },
            blockAt: (p) => ({ name: p.y === 65 ? 'sand' : 'air', boundingBox: p.y === 65 ? 'block' : 'empty' })
        };
        const s = suffocationState(bot);
        assert.equal(s.suffocating, true);
        assert.equal(s.block, 'sand');
    });

    it('clears when the head block is air/water', () => {
        const bot = {
            entity: { position: new Vec3(5.5, 64, 5.5) },
            blockAt: () => ({ name: 'water', boundingBox: 'empty' })
        };
        assert.equal(suffocationState(bot).suffocating, false);
        assert.equal(suffocationState({ entity: null }).suffocating, false);
    });
});

describe('persistent block knowledge', () => {
    it('records visible ores/stations as world-model facts', () => {
        const recorded = [];
        const agent = {
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                findBlocks: () => [{ x: 3, y: 40, z: 2 }],
                blockAt: () => ({ name: 'diamond_ore' })
            },
            world_model: { record: (cat, data) => recorded.push({ cat, ...data }) }
        };
        const n = rememberNotableBlocks(agent, { radius: 24, max: 4 });
        assert.equal(n, 1);
        assert.equal(recorded[0].cat, 'world');
        assert.equal(recorded[0].name, 'diamond_ore');
        assert.equal(recorded[0].kind, 'ore');
        assert.deepEqual(recorded[0].pos, { x: 3, y: 40, z: 2 });
    });

    it('never throws without a world model', () => {
        assert.equal(rememberNotableBlocks({ bot: { entity: { position: new Vec3(0, 64, 0) } } }), 0);
    });
});

describe('entity-vanish tracking', () => {
    it('reports watched entities that disappeared nearby', () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            entities: { a: { id: 10 } } // entity 20 is gone
        };
        const watched = [
            { id: 10, name: 'wolf', position: new Vec3(2, 64, 2) },
            { id: 20, name: 'escort-target', position: new Vec3(5, 64, 5) }
        ];
        const gone = trackVanishedEntities(bot, watched);
        assert.equal(gone.length, 1);
        assert.equal(gone[0].id, 20);
    });

    it('ignores entities that were far away (chunk unload, not vanish)', () => {
        const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: {} };
        const watched = [{ id: 3, name: 'far', position: new Vec3(200, 64, 200) }];
        assert.equal(trackVanishedEntities(bot, watched).length, 0);
    });
});
