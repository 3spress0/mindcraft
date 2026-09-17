import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import settings from '../src/agent/settings.js';
import {
    captureArea,
    saveAreaAsLitematic,
    sanitizeCaptureName,
    normalizeCorners,
    MAX_CAPTURE_VOLUME,
} from '../src/agent/schematics/capture.js';
import { readSchematicFile, materialList } from '../src/utils/schematic.js';
import { library } from '../src/agent/schematics/library.js';

// ---------- mock world ----------

function vec(x, y, z) {
    return {
        x, y, z,
        distanceTo(o) {
            return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2);
        },
    };
}

/**
 * Mock bot backed by a name grid. `world` maps "x,y,z" -> block name or
 * [name, props]. Unknown cells are air; `nullCells` is a set of unloaded ones.
 */
function mockBot(world, nullCells = new Set()) {
    return {
        username: 'TestBot',
        entity: { position: vec(0, 64, 0) },
        blockAt(pos) {
            const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
            if (nullCells.has(key)) return null;
            const entry = world[key];
            if (!entry) return { name: 'air', getProperties: () => ({}) };
            const [name, props] = Array.isArray(entry) ? entry : [entry, {}];
            return { name, getProperties: () => props };
        },
    };
}

/** A solid 2x2x2 cube of stone with one oak-stair corner. */
function cubeWorld(x0, y0, z0) {
    const world = {};
    for (let x = 0; x < 2; x++) {
        for (let y = 0; y < 2; y++) {
            for (let z = 0; z < 2; z++) {
                const key = `${x0 + x},${y0 + y},${z0 + z}`;
                world[key] = (x === 0 && y === 0 && z === 0)
                    ? ['oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' }]
                    : 'stone';
            }
        }
    }
    return world;
}

// ---------- normalizeCorners ----------

test('normalizeCorners orders arbitrary corners', () => {
    const { min, max } = normalizeCorners({ x: 5, y: 70, z: -2 }, { x: 1, y: 64, z: 9 });
    assert.deepEqual([min.x, min.y, min.z], [1, 64, -2]);
    assert.deepEqual([max.x, max.y, max.z], [5, 70, 9]);
});

// ---------- captureArea ----------

test('captureArea captures block names and properties', () => {
    const bot = mockBot(cubeWorld(10, 64, 10));
    const model = captureArea(bot, { x: 10, y: 64, z: 10 }, { x: 11, y: 65, z: 11 });

    assert.equal(model.width, 2);
    assert.equal(model.height, 2);
    assert.equal(model.length, 2);
    assert.equal(model.capture.unloaded, 0);

    const stairs = model.stateAt(0, 0, 0);
    assert.equal(stairs.name, 'oak_stairs');
    assert.deepEqual(stairs.props, { facing: 'north', half: 'bottom', shape: 'straight' });
    assert.equal(model.stateAt(1, 1, 1).name, 'stone');

    const names = model.palette.map((p) => p.name).sort();
    assert.deepEqual(names, ['oak_stairs', 'stone']);
});

test('captureArea skips air and counts unloaded cells', () => {
    const world = cubeWorld(0, 64, 0);
    delete world['1,65,1']; // one air gap inside the box
    const unloaded = new Set(['1,64,1']); // one unloaded cell
    const bot = mockBot(world, unloaded);

    const model = captureArea(bot, { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 1 });
    assert.equal(model.capture.unloaded, 1);

    let filled = 0;
    for (const id of model.voxels) if (id !== 0xFFFFFFFF) filled++;
    assert.equal(filled, 6, '8 cells - 1 air - 1 unloaded');
});

test('captureArea rejects entirely empty captures', () => {
    const bot = mockBot({});
    assert.throws(
        () => captureArea(bot, { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 1 }),
        /no blocks/,
    );
});

test('captureArea rejects oversized boxes', () => {
    const bot = mockBot({});
    assert.throws(
        () => captureArea(bot, { x: 0, y: -64, z: 0 }, { x: 20, y: 320, z: 20 }),
        /limit|too large/i,
    );
    assert.throws(
        () => captureArea(bot, { x: 0, y: 0, z: 0 }, { x: 400, y: 10, z: 10 }),
        /too large/i,
    );
});

// ---------- sanitizeCaptureName ----------

test('sanitizeCaptureName strips extensions and unsafe characters', () => {
    assert.equal(sanitizeCaptureName('my hut.litematic'), 'my_hut');
    assert.equal(sanitizeCaptureName('  weird//name  '), 'weird__name');
    assert.equal(sanitizeCaptureName('spawn_base'), 'spawn_base');
    assert.match(sanitizeCaptureName(''), /^capture_\d+$/);
});

// ---------- saveAreaAsLitematic ----------

let tmpDir = null;
let prevLib = null;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-capture-'));
    prevLib = settings.schematic_library;
    settings.schematic_library = tmpDir;
});

afterEach(() => {
    settings.schematic_library = prevLib;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('saveAreaAsLitematic writes a file the library and reader both accept', async () => {
    const bot = mockBot(cubeWorld(0, 64, 0));
    const res = saveAreaAsLitematic(bot, 'tiny_hut', { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 1 });

    assert.equal(res.name, 'tiny_hut');
    assert.ok(fs.existsSync(res.file), 'file must exist');
    assert.match(res.file, /\.litematic$/);
    assert.equal(res.width, 2);
    assert.equal(res.totalBlocks, 8);
    assert.equal(res.materials.stone, 7);
    assert.equal(res.materials.oak_stairs, 1);

    // The build library now lists it.
    const names = library.scan();
    assert.ok(names.includes('tiny_hut'), `library should list tiny_hut, got: ${names}`);

    // And the schematic reader round-trips it.
    const parsed = await readSchematicFile(res.file);
    assert.equal(parsed.name, 'tiny_hut');
    assert.equal(parsed.width, 2);
    assert.equal(parsed.height, 2);
    assert.equal(parsed.length, 2);
    assert.equal(parsed.stateAt(0, 0, 0).name, 'minecraft:oak_stairs');
    assert.equal(parsed.stateAt(1, 1, 1).name, 'minecraft:stone');

    const mats = materialList(parsed).materials;
    assert.equal(mats.stone, 7);
    assert.equal(mats.oak_stairs, 1);
});

test('saveAreaAsLitematic refuses to overwrite an existing build', () => {
    const bot = mockBot(cubeWorld(0, 64, 0));
    const box = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 1 }];
    saveAreaAsLitematic(bot, 'dup', ...box);
    assert.throws(() => saveAreaAsLitematic(bot, 'dup', ...box), /already exists/);
});

test('saveAreaAsLitematic surfaces empty-capture errors', () => {
    const bot = mockBot({});
    assert.throws(
        () => saveAreaAsLitematic(bot, 'empty', { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 1 }),
        /no blocks/,
    );
});

test('MAX_CAPTURE_VOLUME is a sane default', () => {
    assert.ok(MAX_CAPTURE_VOLUME <= 1_000_000);
    assert.ok(MAX_CAPTURE_VOLUME >= 100_000);
});
