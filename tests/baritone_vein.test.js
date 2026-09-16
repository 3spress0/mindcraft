import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';

import { findVein, mineBlocks } from '../src/agent/baritone/baritone.js';

const registry = minecraftData('1.20.1');

// ---------- mock world ----------

const key = (p) => `${p.x},${p.y},${p.z}`;

function vec(x, y, z) {
    return {
        x, y, z,
        distanceTo(o) {
            return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2);
        },
    };
}

/**
 * Mock bot backed by a Set of ore positions. findBlocks reports the ore
 * positions sorted by distance (like mineflayer); digging removes the block.
 */
function miningBot(orePositions, { digFails = false } = {}) {
    const ore = new Set(orePositions.map((p) => key(p)));
    const dug = [];
    const paths = [];

    const bot = {
        registry, // real registry so buildMovements works; pathfinder itself is mocked
        entity: { position: vec(0, 64, 0) },
        interrupt_code: false,
        findBlocks() {
            return orePositions
                .filter((p) => ore.has(key(p)))
                .sort((a, b) => vec(...[a.x, a.y, a.z]).distanceTo(bot.entity.position) - vec(b.x, b.y, b.z).distanceTo(bot.entity.position))
                .map((p) => vec(p.x, p.y, p.z));
        },
        blockAt(pos) {
            const k = key({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
            return ore.has(k) ? { name: 'iron_ore', position: vec(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) } : null;
        },
        equip: async () => {},
        dig: async (block) => {
            if (digFails) throw new Error('no tool');
            ore.delete(key(block.position));
            dug.push(block.position);
        },
        pathfinder: {
            setMovements() {},
            goto: async () => {},
            bestHarvestTool: () => null,
        },
    };
    bot.pathfinder.goto = async (goal) => { paths.push(goal.describe()); };
    return { bot, dug, paths, ore };
}

// ---------- findVein ----------

test('findVein finds face-connected same-type blocks only', () => {
    const { bot } = miningBot([
        { x: 10, y: 64, z: 10 },
        { x: 11, y: 64, z: 10 }, // connected
        { x: 11, y: 65, z: 10 }, // connected via second hop
        { x: 14, y: 64, z: 10 }, // disconnected (gap)
    ]);
    const start = bot.blockAt({ x: 10, y: 64, z: 10 });
    const vein = findVein(bot, start, 'iron_ore');
    const keys = vein.map((b) => key(b.position)).sort();
    assert.deepEqual(keys, ['11,64,10', '11,65,10']);
});

test('findVein respects the cap and never revisits blocks', () => {
    const line = [];
    for (let i = 0; i < 20; i++) line.push({ x: i, y: 64, z: 0 });
    const { bot } = miningBot(line);
    const start = bot.blockAt({ x: 0, y: 64, z: 0 });
    const vein = findVein(bot, start, 'iron_ore', { cap: 5 });
    assert.equal(vein.length, 5);
    const unique = new Set(vein.map((b) => key(b.position)));
    assert.equal(unique.size, 5);
});

test('findVein returns nothing for isolated blocks', () => {
    const { bot } = miningBot([{ x: 3, y: 64, z: 3 }]);
    const start = bot.blockAt({ x: 3, y: 64, z: 3 });
    assert.deepEqual(findVein(bot, start, 'iron_ore'), []);
});

// ---------- mineBlocks with veins ----------

test('mineBlocks drains the whole vein before searching again', async () => {
    const { bot, dug } = miningBot([
        { x: 10, y: 64, z: 10 },
        { x: 11, y: 64, z: 10 },
        { x: 12, y: 64, z: 10 },
    ]);
    const res = await mineBlocks(bot, 'iron_ore', 3);
    assert.equal(res.mined, 3);
    assert.equal(dug.length, 3);
    assert.equal(bot.findBlocks().length, 0, 'all ore gone');
});

test('mineBlocks honors count limits mid-vein', async () => {
    const { bot, dug } = miningBot([
        { x: 10, y: 64, z: 10 },
        { x: 11, y: 64, z: 10 },
        { x: 12, y: 64, z: 10 },
        { x: 13, y: 64, z: 10 },
    ]);
    const res = await mineBlocks(bot, 'iron_ore', 2);
    assert.equal(res.mined, 2);
    assert.equal(dug.length, 2);
    assert.equal(bot.findBlocks().length, 2, 'rest of the vein left in the ground');
});

test('mineBlocks can disable vein sweeping', async () => {
    const { bot, dug } = miningBot([
        { x: 10, y: 64, z: 10 },
        { x: 11, y: 64, z: 10 },
    ]);
    const res = await mineBlocks(bot, 'iron_ore', 2, { vein: false });
    assert.equal(res.mined, 2);
    assert.equal(dug.length, 2);
});

test('mineBlocks skips stale targets instead of digging air', async () => {
    const { bot, dug, ore } = miningBot([
        { x: 10, y: 64, z: 10 }, // will be stolen before we dig it
        { x: 20, y: 64, z: 20 },
    ]);
    ore.delete('10,64,10'); // someone else mined it between scan and arrival
    const res = await mineBlocks(bot, 'iron_ore', 1);
    assert.equal(res.mined, 1);
    assert.equal(dug.length, 1);
    assert.deepEqual([dug[0].x, dug[0].y, dug[0].z], [20, 64, 20], 'mined the second, real ore');
});

test('mineBlocks stops cleanly when the ore runs out', async () => {
    const { bot, dug } = miningBot([{ x: 10, y: 64, z: 10 }]);
    const res = await mineBlocks(bot, 'iron_ore', 3);
    assert.equal(res.mined, 1);
    assert.equal(dug.length, 1);
    assert.match(res.reason, /no more iron_ore/);
});

test('mineBlocks reports when nothing is found', async () => {
    const { bot } = miningBot([]);
    const res = await mineBlocks(bot, 'diamond_ore', 1);
    assert.equal(res.mined, 0);
    assert.match(res.reason, /no diamond_ore found/);
});

test('mineBlocks honors interrupts', async () => {
    const { bot, dug } = miningBot([{ x: 10, y: 64, z: 10 }]);
    bot.interrupt_code = true;
    const res = await mineBlocks(bot, 'iron_ore', 1);
    assert.equal(res.mined, 0);
    assert.equal(dug.length, 0);
    assert.equal(res.reason, 'interrupted');
});

test('mineBlocks reports dig failures', async () => {
    const { bot } = miningBot([{ x: 10, y: 64, z: 10 }], { digFails: true });
    const res = await mineBlocks(bot, 'iron_ore', 1);
    assert.equal(res.mined, 0);
    assert.match(res.reason, /failed to dig/);
});

test('mineBlocks re-paths only for far targets', async () => {
    const { bot, paths } = miningBot([
        { x: 10, y: 64, z: 10 }, // far from (0,64,0) -> path
        { x: 11, y: 64, z: 10 }, // vein member; bot mock never moves, still far -> path
    ]);
    const res = await mineBlocks(bot, 'iron_ore', 2);
    assert.equal(res.mined, 2);
    assert.equal(paths.length, 2, 'both targets were out of reach for the stationary mock');
    assert.match(paths[0], /GoalGetToBlock/);
});
