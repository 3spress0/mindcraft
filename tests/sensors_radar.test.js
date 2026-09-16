import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    cardinalBearing,
    playerIntel,
    entityIntel,
    groundItems,
    storageScan,
    lineOfSight,
    radarReport,
    playerPositionSnapshot,
    STORAGE_BLOCKS,
} from '../src/agent/sensors/radar.js';

// ---------- mock helpers ----------

function vec(x, y, z) {
    return {
        x, y, z,
        distanceTo(o) {
            return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2);
        },
        offset(dx, dy, dz) {
            return vec(x + dx, y + dy, z + dz);
        },
    };
}

function mockBot({ entities = {}, position = vec(0, 64, 0), findBlocks = null, blockAt = null, username = 'Andy' } = {}) {
    return {
        username,
        entity: { position },
        entities,
        players: {},
        findBlocks: findBlocks || (() => []),
        blockAt: blockAt || (() => null),
    };
}

function playerEntity(x, y, z, username, extra = {}) {
    return {
        type: 'player',
        username,
        position: vec(x, y, z),
        onGround: true,
        metadata: { 0: 0, 9: 20, ...(extra.metadata || {}) },
        ...extra,
    };
}

// ---------- cardinalBearing ----------

test('cardinalBearing maps the Minecraft axes correctly', () => {
    assert.equal(cardinalBearing(0, 1), 'S');   // +Z is south
    assert.equal(cardinalBearing(0, -1), 'N');
    assert.equal(cardinalBearing(1, 0), 'E');   // +X is east
    assert.equal(cardinalBearing(-1, 0), 'W');
    assert.equal(cardinalBearing(1, 1), 'SE');
    assert.equal(cardinalBearing(-1, 1), 'SW');
    assert.equal(cardinalBearing(-1, -1), 'NW');
    assert.equal(cardinalBearing(1, -1), 'NE');
});

test('cardinalBearing covers all 16 points', () => {
    const seen = new Set();
    for (let deg = 0; deg < 360; deg += 5) {
        const rad = (deg * Math.PI) / 180;
        seen.add(cardinalBearing(Math.sin(rad), Math.cos(rad)));
    }
    assert.equal(seen.size, 16);
});

// ---------- playerIntel ----------

test('playerIntel returns exact positions, distance and bearing', () => {
    const bot = mockBot({
        entities: {
            1: playerEntity(10, 64, 10, 'Steve'),
            2: playerEntity(-30, 70, 4, 'Alex'),
        },
    });
    const intel = playerIntel(bot, 64);
    assert.equal(intel.length, 2);

    assert.equal(intel[0].username, 'Steve'); // closer first
    assert.deepEqual(intel[0].position, { x: 10, y: 64, z: 10 });
    assert.ok(Math.abs(intel[0].distance - Math.sqrt(200)) < 0.1);
    assert.equal(intel[0].bearing, 'SE');
    assert.equal(intel[0].health, 20);
    assert.equal(intel[0].onGround, true);

    assert.equal(intel[1].username, 'Alex');
});

test('playerIntel respects maxDistance and excludes self', () => {
    const bot = mockBot({
        entities: {
            1: playerEntity(3, 64, 4, 'Steve'),        // 5m away
            2: playerEntity(100, 64, 0, 'FarAway'),    // 100m away
            3: playerEntity(0, 64, 0, 'Andy'),         // the bot itself
        },
    });
    const intel = playerIntel(bot, 16);
    assert.deepEqual(intel.map((p) => p.username), ['Steve']);
});

test('playerIntel reads sneak/sprint flags from shared metadata', () => {
    const bot = mockBot({
        entities: {
            1: playerEntity(2, 64, 0, 'Steve', { metadata: { 0: 0x02 | 0x08, 9: 12 } }),
        },
    });
    const [p] = playerIntel(bot);
    assert.equal(p.sneaking, true);
    assert.equal(p.sprinting, true);
    assert.equal(p.health, 12);
});

test('playerIntel tolerates missing metadata (older/newer versions)', () => {
    const bot = mockBot({
        entities: {
            1: { type: 'player', username: 'Steve', position: vec(5, 64, 0) }, // no metadata at all
        },
    });
    const [p] = playerIntel(bot);
    assert.equal(p.health, null);
    assert.equal(p.sneaking, false);
});

// ---------- entityIntel ----------

test('entityIntel lists mobs with positions, skipping players and items', () => {
    const bot = mockBot({
        entities: {
            1: playerEntity(2, 64, 0, 'Steve'),
            2: { type: 'mob', name: 'zombie', id: 2, position: vec(8, 64, 8), metadata: { 9: 18 } },
            3: { type: 'object', name: 'item', id: 3, position: vec(1, 64, 1) },
            4: { type: 'mob', name: 'cow', id: 4, position: vec(300, 64, 0) }, // out of range
        },
    });
    const intel = entityIntel(bot, 32);
    assert.equal(intel.length, 1);
    assert.equal(intel[0].name, 'zombie');
    assert.equal(intel[0].health, 18);
    assert.equal(intel[0].bearing, 'SE'); // +x, +z is south-east
});

// ---------- groundItems ----------

test('groundItems extracts stack info from item entity metadata', () => {
    const bot = mockBot({
        entities: {
            1: { type: 'object', name: 'item', position: vec(2, 64, 2), metadata: { 8: { name: 'diamond', itemCount: 3 } } },
            2: { type: 'mob', name: 'zombie', position: vec(3, 64, 3) },
            3: { type: 'object', name: 'item', position: vec(100, 64, 0), metadata: { 8: { name: 'iron_ingot', itemCount: 1 } } },
        },
    });
    const items = groundItems(bot, 16);
    assert.equal(items.length, 1);
    assert.equal(items[0].item, 'diamond');
    assert.equal(items[0].count, 3);
    assert.equal(items[0].bearing, 'SE');
});

// ---------- storageScan ----------

test('storageScan finds containers by name and groups counts', () => {
    const spots = [vec(2, 64, 0), vec(0, 64, 3), vec(5, 63, 5)];
    const blocks = {
        '2,64,0': { name: 'chest' },
        '0,64,3': { name: 'chest' },
        '5,63,5': { name: 'furnace' },
    };
    const bot = mockBot({
        findBlocks: ({ maxDistance, count }) => spots,
        blockAt: (p) => blocks[`${p.x},${p.y},${p.z}`] || { name: 'stone' },
    });
    const { positions, counts } = storageScan(bot, 24);
    assert.equal(positions.length, 3);
    assert.deepEqual(counts, { chest: 2, furnace: 1 });
    assert.equal(positions[0].distance <= positions[2].distance, true, 'sorted by distance');
});

test('storageScan is safe when findBlocks throws', () => {
    const bot = mockBot({ findBlocks: () => { throw new Error('no chunks'); } });
    const res = storageScan(bot);
    assert.deepEqual(res, { positions: [], counts: {} });
});

test('STORAGE_BLOCKS covers common containers', () => {
    for (const name of ['chest', 'ender_chest', 'barrel', 'hopper', 'blast_furnace', 'red_shulker_box']) {
        assert.ok(STORAGE_BLOCKS.has(name), name);
    }
});

// ---------- lineOfSight ----------

test('lineOfSight is blocked by solid blocks and passes through air/torches', () => {
    const solid = { name: 'stone', boundingBox: 'block' };
    const air = { name: 'air', boundingBox: 'empty' };
    const torch = { name: 'torch', boundingBox: 'empty' };

    const wallAtX5 = (p) => (Math.floor(p.x) === 5 ? solid : air);
    let bot = mockBot({ blockAt: wallAtX5 });
    assert.equal(lineOfSight(bot, { x: 10, y: 64, z: 0 }), false, 'wall blocks view');

    const torchLine = (p) => (Math.floor(p.x) === 5 ? torch : air);
    bot = mockBot({ blockAt: torchLine });
    assert.equal(lineOfSight(bot, { x: 10, y: 64, z: 0 }), true, 'torches do not block view');
});

test('lineOfSight treats unloaded cells as non-occluding', () => {
    const bot = mockBot({ blockAt: () => null });
    assert.equal(lineOfSight(bot, { x: 20, y: 64, z: 0 }), true);
});

test('lineOfSight fails beyond maxDistance', () => {
    const bot = mockBot({ blockAt: () => ({ name: 'air', boundingBox: 'empty' }) });
    assert.equal(lineOfSight(bot, { x: 100, y: 64, z: 0 }, { maxDistance: 32 }), false);
});

// ---------- report + snapshot ----------

test('radarReport renders players, entities, items and storage', () => {
    const bot = mockBot({
        entities: {
            1: playerEntity(10, 64, 0, 'Steve'),
            2: { type: 'mob', name: 'zombie', id: 2, position: vec(-5, 64, -5), metadata: { 9: 20 } },
            3: { type: 'object', name: 'item', position: vec(2, 64, 0), metadata: { 8: { name: 'bread', itemCount: 2 } } },
        },
        findBlocks: () => [vec(4, 64, 4)],
        blockAt: (p) => ({ name: 'chest', boundingBox: 'block' }),
    });
    const report = radarReport(bot);
    assert.match(report, /RADAR/);
    assert.match(report, /Steve at \(10, 64, 0\)/);
    assert.match(report, /zombie/);
    assert.match(report, /bread x2/);
    assert.match(report, /1 chest/);
});

test('radarReport handles an empty world gracefully', () => {
    const bot = mockBot();
    const report = radarReport(bot);
    assert.match(report, /Players: none in range/);
    assert.match(report, /Storage: none in range/);
});

test('playerPositionSnapshot is compact and capped', () => {
    const entities = {};
    for (let i = 0; i < 12; i++) {
        entities[i] = playerEntity(i + 1, 64, 0, `P${i}`);
    }
    const bot = mockBot({ entities });
    const snap = playerPositionSnapshot(bot, 64, 8);
    assert.equal(snap.length, 8);
    assert.deepEqual(Object.keys(snap[0]).sort(), ['bearing', 'distance', 'name', 'x', 'y', 'z']);
});

test('radar survives bots with no entities at all', () => {
    const bot = { username: 'Andy', entity: { position: vec(0, 64, 0) }, players: {} };
    assert.deepEqual(playerIntel(bot), []);
    assert.deepEqual(entityIntel(bot), []);
    assert.deepEqual(groundItems(bot), []);
});
