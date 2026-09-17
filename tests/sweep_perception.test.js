/**
 * sweep_perception.test.js — perception sweep: movement/chunk awareness,
 * visibility scoring, sounds, fall risk, safe zones, combat FSM, and
 * threat-aware route scoring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { movementState, chunkStatus, visibilityScore, attachSoundAwareness, recentSounds, notableSounds } from '../src/agent/sensors/awareness.js';
import { fallRiskAt } from '../src/agent/navigation/hazards.js';
import { scoreSafeSpot, scanSafeSpots, noteSafeSpot, recordDangerSpot, knownSafeSpots, knownDangerSpots } from '../src/agent/navigation/safe_zones.js';
import { updateCombatState, combatStateLine, scoreThreats, decideEscape } from '../src/agent/autonomy/combat.js';
import { threatExposure, chooseSaferRoute } from '../src/agent/navigation/route_choice.js';
import { WorldModel } from '../src/agent/world_model/world_model.js';

function solidBot({ solid = true, light = 12 } = {}) {
    return {
        entity: { position: new Vec3(0, 64, 0), onGround: true, velocity: { x: 0.1, y: 0, z: 0 } },
        controlState: { sneak: false, sprint: true },
        vehicle: null,
        world: { getColumnAt: () => ({}) },
        blockAt: (p) => {
            if (p.y <= 63) return solid ? { name: 'stone' } : { name: 'air' };
            return { name: 'air' };
        },
        lightLevelAt: () => light,
        lightAt: () => 15
    };
}

describe('movement + chunk awareness', () => {
    it('reports ground/sprint state and horizontal speed', () => {
        const st = movementState(solidBot());
        assert.equal(st.onGround, true);
        assert.equal(st.sprinting, true);
        assert.equal(st.riding, false);
        assert.ok(st.speedH > 0);
        assert.deepEqual(st.position, { x: 0, y: 64, z: 0 });
    });

    it('never throws on a bare bot', () => {
        const st = movementState({});
        assert.equal(st.onGround, true); // safe default
        assert.equal(st.position, null);
    });

    it('chunk status reports the chunk and loaded columns', () => {
        const cs = chunkStatus(solidBot());
        assert.equal(cs.chunkX, 0);
        assert.equal(cs.chunkZ, 0);
        assert.equal(cs.loaded, true);
        assert.equal(cs.loadedAround, 9);
        assert.equal(cs.total, 9);
    });
});

describe('visibility scoring', () => {
    it('clear nearby view scores high', () => {
        const bot = solidBot();
        const score = visibilityScore(bot, { x: 5, y: 64, z: 0 });
        assert.ok(score > 0.5, `expected high visibility, got ${score}`);
    });

    it('out of range scores zero', () => {
        const bot = solidBot();
        assert.equal(visibilityScore(bot, { x: 500, y: 64, z: 0 }, { maxDist: 48 }), 0);
    });

    it('blocked line of sight lowers the score', () => {
        const bot = solidBot();
        bot.blockAt = (p) => (p.x === 3 ? { name: 'stone' } : p.y < 63 ? { name: 'stone' } : { name: 'air' });
        const blocked = visibilityScore(bot, { x: 6, y: 64, z: 0 });
        const clear = visibilityScore({ ...bot, blockAt: () => ({ name: 'air' }) }, { x: 6, y: 64, z: 0 });
        assert.ok(blocked < clear);
    });
});

describe('sound awareness', () => {
    it('collects recent sounds and filters notable ones', () => {
        const fakeEmitter = { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; } };
        attachSoundAwareness(fakeEmitter);
        fakeEmitter.handlers.soundEffectHeard('entity.zombie.hurt', { x: 10, z: -3 });
        fakeEmitter.handlers.soundEffectHeard('block.note.harp', { x: 1, z: 1 });
        const recent = recentSounds(fakeEmitter, { windowMs: 5000 });
        assert.equal(recent.length, 2);
        const notable = notableSounds(fakeEmitter, { windowMs: 5000 });
        assert.ok(notable.some(s => s.name.includes('hurt')));
        // bounded ring
        for (let i = 0; i < 60; i++) fakeEmitter.handlers.soundEffectHeard('ambient.cave', { x: 0, z: 0 });
        assert.ok(recentSounds(fakeEmitter, { windowMs: 60000 }).length <= 48);
    });
});

describe('fall-risk evaluation', () => {
    it('flat ground is no risk', () => {
        const bot = solidBot();
        const r = fallRiskAt(bot, { x: 0, y: 64, z: 0 });
        assert.equal(r.risk, 'none');
        assert.equal(r.drop, 0);
    });

    it('a deep gap is lethal', () => {
        const bot = solidBot();
        // only solid below y=40: standing at 64 means a 23-block drop
        bot.blockAt = (p) => (p.y <= 40 ? { name: 'stone' } : { name: 'air' });
        const r = fallRiskAt(bot, { x: 0, y: 64, z: 0 });
        assert.equal(r.risk, 'lethal');
        assert.ok(r.drop > 8);
    });

    it('water breaks the fall', () => {
        const bot = solidBot();
        bot.blockAt = (p) => (p.y === 60 ? { name: 'water' } : p.y <= 59 ? { name: 'stone' } : { name: 'air' });
        const r = fallRiskAt(bot, { x: 0, y: 64, z: 0 });
        assert.equal(r.risk, 'none');
        assert.equal(r.water, true);
    });
});

describe('safe zones', () => {
    function caveBot() {
        // floor at y=63, walls far away, one lava pool at (3,63,3)
        return {
            entity: { position: new Vec3(0, 64, 0) },
            blockAt: (p) => {
                if (p.x === 3 && p.z === 3 && p.y === 63) return { name: 'lava' };
                if (p.y === 63) return { name: 'stone' };
                if (p.y === 66) return { name: 'stone' }; // roof cover
                return { name: 'air' };
            },
            lightLevelAt: () => 10,
            world_model: new WorldModel()
        };
    }

    it('scores a covered, lit, hazard-free spot', () => {
        const bot = caveBot();
        const score = scoreSafeSpot(bot, { x: -2, y: 64, z: -2 });
        assert.ok(score != null && score > 2, `expected good score, got ${score}`);
    });

    it('refuses spots with no floor or lava underfoot', () => {
        const bot = caveBot();
        assert.equal(scoreSafeSpot(bot, { x: 0, y: 70, z: 0 }), null); // air below
        assert.equal(scoreSafeSpot(bot, { x: 3, y: 64, z: 3 }), null);  // lava floor
    });

    it('scan returns best-first spots, deduplicated', () => {
        const bot = caveBot();
        const spots = scanSafeSpots(bot, { radius: 6, maxSpots: 4 });
        assert.ok(spots.length >= 1);
        for (let i = 1; i < spots.length; i++) {
            assert.ok(spots[i - 1].score >= spots[i].score);
        }
    });

    it('safe/danger spots persist as world-model facts and query back', () => {
        const bot = caveBot();
        const agent = { bot, world_model: bot.world_model };
        assert.equal(noteSafeSpot(agent, { x: 1, y: 64, z: 1 }), true);
        assert.equal(recordDangerSpot(agent, { pos: { x: 3, y: 64, z: 3 }, reason: 'lava' }), true);
        const safe = knownSafeSpots(agent);
        const danger = knownDangerSpots(agent);
        assert.ok(safe.length >= 1);
        assert.ok(safe.some(s => s.name.startsWith('safe:')));
        assert.ok(danger.length >= 1);
        assert.ok(danger.some(d => d.label === 'lava'));
    });
});

describe('combat state machine', () => {
    function combatBot({ hostiles = {}, health = 20 } = {}) {
        return {
            health,
            entity: { position: new Vec3(0, 64, 0) },
            entities: hostiles,
            inventory: { slots: new Array(46).fill(null) }
        };
    }
    const mob = (name, x, z = 0) => ({ name, position: new Vec3(x, 64, z) });

    it('idle with no threats', () => {
        const st = updateCombatState(combatBot());
        assert.equal(st.phase, 'idle');
        assert.equal(st.total, 0);
        assert.ok(combatStateLine(st).includes('idle'));
    });

    it('engaged when threats are close', () => {
        const bot = combatBot({ hostiles: { m1: mob('skeleton', 3) } });
        const st = updateCombatState(bot);
        assert.equal(st.phase, 'engaged');
    });

    it('fleeing when overwhelmed, with phase-change bookkeeping', () => {
        const bot = combatBot({
            hostiles: { m1: mob('creeper', 2), m2: mob('skeleton', 3), m3: mob('wither_skeleton', 2, 2) }
        });
        const st = updateCombatState(bot);
        assert.equal(st.phase, 'fleeing');
        const again = updateCombatState(bot);
        assert.equal(again.since, st.since, 'phase unchanged -> since untouched');
    });

    it('tracks damage taken from health deltas', () => {
        const bot = combatBot({ health: 20 });
        updateCombatState(bot);
        bot.health = 14;
        const st = updateCombatState(bot);
        assert.equal(st.lastDamageTaken, 6);
        assert.ok(st.lastDamageAt > 0);
    });

    it('critical health decides escape even without threats', () => {
        const bot = combatBot({ health: 4 });
        assert.equal(decideEscape(bot).flee, true);
    });

    it('threat entries carry coordinates for route scoring', () => {
        const bot = combatBot({ hostiles: { m1: mob('skeleton', 5, 0) } });
        const { threats } = scoreThreats(bot, {});
        assert.equal(threats.length, 1);
        assert.equal(threats[0].x, 5);
        assert.equal(threats[0].z, 0);
    });
});

describe('threat-aware route scoring', () => {
    const route = (pts) => ({ waypoints: pts.map(([x, z]) => ({ x, y: 64, z })) });

    it('threat exposure decays with distance', () => {
        const threats = [{ x: 5, z: 0, score: 3 }];
        const near = threatExposure(route([[5, 0]]).waypoints, threats, { corridor: 8 });
        const far = threatExposure(route([[40, 0]]).waypoints, threats, { corridor: 8 });
        assert.ok(near.score > 0);
        assert.equal(far.score, 0);
    });

    it('chooseSaferRoute avoids the route passing the creeper', () => {
        // dense waypoints so the threat corridor is actually sampled
        const risky = route([[0, 0], [5, 0], [10, 0], [15, 0], [20, 0]]);
        const safe = route([[0, -12], [10, -12], [20, -12]]);
        const threats = [{ x: 10, z: 0, score: 4 }];
        const { index } = chooseSaferRoute([risky, safe], [], { threats, threatWeight: 6 });
        assert.equal(index, 1, 'should pick the route away from the threat');
    });

    it('with no threats, the shorter route wins', () => {
        const short = route([[0, 0], [10, 0]]);
        const long = route([[0, 0], [10, 0], [10, 10], [20, 10]]);
        const { index } = chooseSaferRoute([short, long], [], { threats: [] });
        assert.equal(index, 0);
    });
});
