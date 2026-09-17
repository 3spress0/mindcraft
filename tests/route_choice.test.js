import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    routeLength, hazardExposure, chooseSaferRoute,
    avoidZonesFromHazards, inAvoidZone
} from '../src/agent/navigation/route_choice.js';
import { nextFrontierGoal, ExplorationState } from '../src/agent/navigation/exploration.js';

function line(x0, z0, x1, z1, steps = 5) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
        out.push({ x: x0 + (x1 - x0) * i / steps, y: 64, z: z0 + (z1 - z0) * i / steps });
    }
    return out;
}

describe('routeLength', () => {
    it('sums segment lengths', () => {
        assert.equal(routeLength([{ x: 0, z: 0 }, { x: 3, z: 4 }]), 5);
        assert.equal(routeLength([]), 0);
        assert.equal(routeLength(null), 0);
    });
});

describe('hazardExposure', () => {
    const lava = [{ name: 'lava', tier: 'hard', x: 5, z: 0 }];

    it('scores points passing near a hazard', () => {
        const through = line(0, 0, 10, 0, 10); // passes right over lava at (5,0)
        const around = line(0, 20, 10, 20, 10); // 20 blocks clear
        const t = hazardExposure(through, lava, { corridor: 4 });
        const a = hazardExposure(around, lava, { corridor: 4 });
        assert.ok(t.exposed > 0);
        assert.equal(a.exposed, 0);
        assert.ok(t.score > a.score);
    });

    it('weights hard hazards above soft', () => {
        const soft = [{ name: 'cobweb', tier: 'soft', x: 5, z: 0 }];
        const through = line(0, 0, 10, 0, 10);
        const hard = hazardExposure(through, lava, { corridor: 4 });
        const softr = hazardExposure(through, soft, { corridor: 4 });
        assert.ok(hard.score > softr.score);
    });

    it('empty route -> zero exposure', () => {
        assert.equal(hazardExposure([], lava).score, 0);
    });
});

describe('chooseSaferRoute', () => {
    it('prefers a hazard-free detour over a dangerous shortcut', () => {
        const hazards = [{ name: 'lava', tier: 'hard', x: 5, z: 0 }];
        const shortcut = { waypoints: line(0, 0, 10, 0, 10) };  // short but crosses lava
        const detour = { waypoints: line(0, 20, 10, 20, 10) };  // longer but clear
        const { chosen, index } = chooseSaferRoute([shortcut, detour], hazards, { corridor: 4, riskWeight: 8 });
        assert.equal(index, 1);
        assert.equal(chosen, detour);
    });

    it('takes the shorter route when both are safe', () => {
        const short = { waypoints: line(0, 0, 5, 0, 5) };
        const long = { waypoints: line(0, 10, 20, 10, 10) };
        const { index } = chooseSaferRoute([short, long], [], {});
        assert.equal(index, 0);
    });

    it('returns null for no candidates', () => {
        assert.equal(chooseSaferRoute([], []).chosen, null);
        assert.equal(chooseSaferRoute([{}], []).index, -1);
    });
});

describe('avoidZonesFromHazards', () => {
    it('builds zones with a wider berth for hard hazards', () => {
        const hazards = [
            { name: 'lava', tier: 'hard', x: 10, z: 10 },
            { name: 'cobweb', tier: 'soft', x: 40, z: 40 }
        ];
        const zones = avoidZonesFromHazards(hazards, { radius: 10 });
        assert.equal(zones.length, 2);
        const hard = zones.find(z => z.x === 10);
        const soft = zones.find(z => z.x === 40);
        assert.ok(hard.r > soft.r);
    });

    it('caps zone count', () => {
        const hazards = Array.from({ length: 30 }, (_, i) => ({ name: 'lava', tier: 'hard', x: i * 100, z: 0 }));
        assert.equal(avoidZonesFromHazards(hazards, { maxZones: 16 }).length, 16);
    });

    it('inAvoidZone detects membership', () => {
        const zones = [{ x: 0, z: 0, r: 10 }];
        assert.equal(inAvoidZone(3, 4, zones), true);
        assert.equal(inAvoidZone(50, 50, zones), false);
        assert.equal(inAvoidZone(0, 0, []), false);
        assert.equal(inAvoidZone(0, 0, null), false);
    });
});

describe('risk-aware frontier exploration', () => {
    it('steers frontier goals away from avoid-zones', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        // zones poisoning every first-ring bearing EXCEPT +X (0deg)
        const ring = 16; // first ring radius
        const zones = [];
        for (let deg = 45; deg < 360; deg += 45) {
            const a = deg * Math.PI / 180;
            zones.push({ x: Math.round(Math.cos(a) * ring), z: Math.round(Math.sin(a) * ring), r: 8 });
        }
        const rng = { range: () => 0 }; // deterministic bearings -> candidates at 0,45,...
        const goal = nextFrontierGoal(state, { rng, avoid: zones });
        assert.equal(inAvoidZone(goal.x, goal.z, zones), false, 'goal must steer clear of zones');
        assert.equal(goal.x, 16); // the clear +X corridor
        assert.equal(goal.z, 0);
    });

    it('falls back to an avoided goal when nothing else is available', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        // a zone covering everything near origin forces fallback use
        const zones = [{ x: 0, z: 0, r: 1000 }];
        const goal = nextFrontierGoal(state, { rng: { range: () => 0 }, avoid: zones });
        assert.ok(goal, 'still returns a goal rather than giving up');
        assert.ok(typeof goal.x === 'number' && typeof goal.z === 'number');
    });
});

describe('route variety and penalties', () => {
    it('penalty handicaps a route (e.g. block-breaking probe)', () => {
        // identical geometry: without penalty index 0 wins (first); with a big
        // penalty on route 0, route 1 wins
        const r0 = { waypoints: line(0, 0, 10, 0, 10) };
        const r1 = { waypoints: line(0, 0, 10, 0, 10) };
        assert.equal(chooseSaferRoute([r0, r1], []).index, 0);
        const penalized = chooseSaferRoute([{ ...r0, penalty: 50 }, r1], []);
        assert.equal(penalized.index, 1);
    });

    it('no rng or zero chance -> never varies', async () => {
        const { createRng: rngFactory } = await import('../src/agent/humanlike/rng.js');
        const routes = [
            { waypoints: line(0, 0, 10, 0, 10) },
            { waypoints: line(0, 1, 10, 1, 10) } // near-equivalent
        ];
        for (let i = 0; i < 10; i++) {
            const res = chooseSaferRoute(routes, [], { rng: rngFactory(`v${i}`), varietyChance: 0 });
            assert.equal(res.varied, false);
            assert.equal(res.index, 0);
        }
    });

    it('seeded variety occasionally takes a near-equivalent alternate', async () => {
        const { createRng: rngFactory } = await import('../src/agent/humanlike/rng.js');
        const routes = [
            { waypoints: line(0, 0, 10, 0, 10) },
            { waypoints: line(0, 1, 10, 1, 10) }
        ];
        let varied = 0;
        const picks = [];
        for (let i = 0; i < 40; i++) {
            const res = chooseSaferRoute(routes, [], { rng: rngFactory(`variety-${i}`), varietyChance: 0.35 });
            picks.push(res.index);
            if (res.varied) varied++;
        }
        assert.ok(varied > 0, 'variety should fire sometimes');
        assert.ok(varied < 40, '...but not always');
        // same seed -> same decision (reproducible)
        const a = chooseSaferRoute(routes, [], { rng: rngFactory('fixed'), varietyChance: 0.35 });
        const b = chooseSaferRoute(routes, [], { rng: rngFactory('fixed'), varietyChance: 0.35 });
        assert.equal(a.index, b.index);
        assert.equal(a.varied, b.varied);
    });

    it('never varies into a clearly worse route', async () => {
        const { createRng: rngFactory } = await import('../src/agent/humanlike/rng.js');
        const routes = [
            { waypoints: line(0, 0, 10, 0, 10) },        // 10 blocks
            { waypoints: line(0, 0, 100, 0, 10) }        // 100 blocks
        ];
        for (let i = 0; i < 20; i++) {
            const res = chooseSaferRoute(routes, [], { rng: rngFactory(`worse-${i}`), varietyChance: 0.9 });
            assert.equal(res.index, 0, 'tolerance must keep bad routes out');
            assert.equal(res.varied, false);
        }
    });
});
