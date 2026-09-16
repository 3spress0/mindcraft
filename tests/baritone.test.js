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
    mineBlocks,
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

function miningBot({ blocksFound = 2, vanishAfter = -1, digFails = false } = {}) {
    const dug = [];
    const equipped = [];
    let findCalls = 0;
    const positions = Array.from({ length: blocksFound }, (_, i) => ({ x: 10 + i, y: 64, z: 10 }));

    const bot = baseBot({
        pathfinder: {
            setMovements: () => {},
            goto: async () => {},
            bestHarvestTool: () => ({ name: 'iron_pickaxe' }),
        },
        findBlocks: () => {
            const p = positions[findCalls];
            findCalls++;
            return p && findCalls <= blocksFound ? [p] : [];
        },
        blockAt: (pos) => {
            if (vanishAfter >= 0 && findCalls > vanishAfter + 1) return { name: 'air', position: pos };
            return { name: 'iron_ore', position: pos };
        },
        equip: async (item) => { equipped.push(item); },
        dig: async (block) => {
            if (digFails) throw new Error('no tool');
            dug.push(block.position);
        },
    });
    return { bot, dug, equipped };
}

test('mineBlocks walks to and digs the requested number of blocks', async () => {
    const { bot, dug, equipped } = miningBot({ blocksFound: 3 });
    const progress = [];
    const res = await mineBlocks(bot, 'iron_ore', 2, {
        onProgress: (done, total) => progress.push([done, total]),
    });
    assert.equal(res.mined, 2);
    assert.equal(res.requested, 2);
    assert.equal(dug.length, 2);
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
    assert.ok(equipped.length >= 1, 'should equip the best harvest tool');
});

test('mineBlocks stops early when the ore runs out', async () => {
    const { bot, dug } = miningBot({ blocksFound: 1 });
    const res = await mineBlocks(bot, 'iron_ore', 3);
    assert.equal(res.mined, 1);
    assert.equal(dug.length, 1);
    assert.match(res.reason, /no more iron_ore/);
});

test('mineBlocks reports when nothing is found at all', async () => {
    const { bot, dug } = miningBot({ blocksFound: 0 });
    const res = await mineBlocks(bot, 'diamond_ore', 2);
    assert.equal(res.mined, 0);
    assert.equal(dug.length, 0);
    assert.match(res.reason, /no diamond_ore found/);
});

test('mineBlocks skips blocks that vanish before digging', async () => {
    const { bot, dug } = miningBot({ blocksFound: 2, vanishAfter: 0 });
    const res = await mineBlocks(bot, 'iron_ore', 2);
    assert.equal(dug.length, 1, 'only the first block still exists');
    assert.ok(res.mined <= 1);
});

test('mineBlocks honors interrupts', async () => {
    const { bot, dug } = miningBot({ blocksFound: 5 });
    bot.interrupt_code = true;
    const res = await mineBlocks(bot, 'iron_ore', 3);
    assert.equal(res.mined, 0);
    assert.equal(dug.length, 0);
    assert.equal(res.reason, 'interrupted');
});

test('mineBlocks reports dig failures', async () => {
    const { bot } = miningBot({ blocksFound: 2, digFails: true });
    const res = await mineBlocks(bot, 'iron_ore', 2);
    assert.equal(res.mined, 0);
    assert.match(res.reason, /failed to dig/);
});

test('GoalGetToBlock is the goal used for mining reach', () => {
    const g = new GoalGetToBlock(10, 64, 10);
    assert.ok(g.isEnd({ x: 11, y: 64, z: 10 }), 'miner stands beside the block');
});
