import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';

import {
    PROFILES,
    PROFILE_NAMES,
    profileNames,
    describeProfile,
    applyProfile,
    getProfileName,
    setProfileName,
    profileDocs,
} from '../src/agent/baritone/settings.js';
import {
    buildMovements,
    previewPath,
    status,
} from '../src/agent/baritone/baritone.js';
import { GoalBlock, GoalGetToBlock } from '../src/agent/baritone/goals.js';

// ---------- settings ----------

test('all documented profiles exist and have tweaks', () => {
    assert.deepEqual(profileNames(), ['default', 'legit', 'fast', 'builder']);
    for (const name of PROFILE_NAMES) {
        assert.ok(PROFILES[name].description.length > 0);
        assert.ok(Object.keys(PROFILES[name].tweaks).length > 0);
        assert.ok(describeProfile(name));
    }
    assert.equal(describeProfile('nope'), null);
});

test('legit profile disables sprint, parkour and digging', () => {
    const fake = {
        allowSprinting: true,
        allowParkour: true,
        allowFreeMotion: true,
        canDig: true,
        allow1by1towers: true,
        maxDropDown: 4,
        digCost: 1,
        placeCost: 1,
    };
    applyProfile(fake, 'legit');
    assert.equal(fake.allowSprinting, false);
    assert.equal(fake.allowParkour, false);
    assert.equal(fake.allowFreeMotion, false);
    assert.equal(fake.canDig, false);
    assert.equal(fake.allow1by1towers, false);
    assert.equal(fake.maxDropDown, 3);
});

test('default profile keeps mindcraft historic costs', () => {
    const fake = { digCost: 1, placeCost: 1, canDig: true };
    applyProfile(fake, 'default');
    assert.equal(fake.digCost, 10);
    assert.equal(fake.placeCost, 2);
    assert.equal(fake.canDig, true, 'default does not touch canDig');
});

test('applyProfile ignores fields the movements object does not have', () => {
    const minimal = { digCost: 1 };
    applyProfile(minimal, 'legit');
    assert.equal(minimal.digCost, 1, 'legit has no digCost tweak anyway');
    assert.ok(!('canDig' in minimal), 'unknown fields are not injected');
});

test('unknown profile falls back to default tweaks', () => {
    const fake = { digCost: 1, placeCost: 1 };
    applyProfile(fake, 'does-not-exist');
    assert.equal(fake.digCost, 10);
});

test('per-bot profile state', () => {
    const bot = {};
    assert.equal(getProfileName(bot), 'default');
    setProfileName(bot, 'fast');
    assert.equal(getProfileName(bot), 'fast');
    assert.throws(() => setProfileName(bot, 'rocket'), /Unknown path profile/);
    assert.equal(getProfileName(null), 'default');
});

test('profileDocs marks the active profile', () => {
    const docs = profileDocs('legit');
    assert.match(docs, /legit \(active\)/);
    assert.match(docs, /builder:/);
});

// ---------- movements construction (real minecraft-data registry) ----------

const registry = minecraftData('1.20.1');

function baseBot(overrides = {}) {
    return {
        registry,
        entity: { position: { x: 0, y: 64, z: 0, distanceTo: (o) => Math.hypot(o.x, o.y - 64, o.z) } },
        interrupt_code: false,
        ...overrides,
    };
}

test('buildMovements applies the active profile', () => {
    const bot = baseBot();
    setProfileName(bot, 'legit');
    const m = buildMovements(bot);
    assert.equal(m.canDig, false);
    assert.equal(m.allowSprinting, false);

    const bot2 = baseBot();
    const m2 = buildMovements(bot2, 'fast');
    assert.equal(m2.canDig, true);
    assert.equal(m2.allowSprinting, true);
});

// ---------- previewPath ----------

test('previewPath reports success without moving', () => {
    let moved = false;
    const bot = baseBot({
        pathfinder: {
            getPathTo: (movements, goal, timeout) => ({
                status: 'success',
                cost: 42.5,
                path: [{ x: 1 }, { x: 2 }, { x: 3 }],
                visitedNodes: 17,
            }),
            setMovements: () => { moved = true; },
            goto: () => { moved = true; },
        },
    });
    const res = previewPath(bot, new GoalBlock(3, 64, 0));
    assert.equal(res.ok, true);
    assert.equal(res.status, 'success');
    assert.equal(res.nodes, 3);
    assert.equal(res.cost, 42.5);
    assert.equal(res.visitedNodes, 17);
    assert.equal(res.profile, 'default');
    assert.match(res.goal, /GoalBlock/);
    assert.equal(moved, false, 'preview must never set movements or walk');
});

test('previewPath reports failure and pathfinder errors', () => {
    const bot = baseBot({
        pathfinder: { getPathTo: () => ({ status: 'timeout', path: [] }) },
    });
    const res = previewPath(bot, new GoalBlock(0, 64, 0));
    assert.equal(res.ok, false);
    assert.equal(res.status, 'timeout');

    const broken = baseBot({
        pathfinder: { getPathTo: () => { throw new Error('chunks not loaded'); } },
    });
    const errRes = previewPath(broken, new GoalBlock(0, 64, 0));
    assert.equal(errRes.ok, false);
    assert.equal(errRes.status, 'error');
    assert.match(errRes.error, /chunks not loaded/);
});

// ---------- status ----------

test('status line shows profile, movement and goal', () => {
    const goal = new GoalBlock(1, 2, 3);
    const bot = baseBot({
        pathfinder: { goal, isMoving: () => true },
    });
    setProfileName(bot, 'builder');
    const line = status(bot);
    assert.match(line, /profile=builder/);
    assert.match(line, /moving=yes/);
    assert.match(line, /GoalBlock/);

    const idle = baseBot({ pathfinder: { goal: null, isMoving: () => false } });
    assert.match(status(idle), /moving=no.*goal=none/);
});

// ---------- mineBlocks ----------
// Vein-aware mining behavior lives in tests/baritone_vein.test.js, which uses
// an ore-set mock compatible with the vein sweep.

test('GoalGetToBlock is the goal used for mining reach', () => {
    const g = new GoalGetToBlock(10, 64, 10);
    assert.ok(g.isEnd({ x: 11, y: 64, z: 10 }), 'miner stands beside the block');
});
