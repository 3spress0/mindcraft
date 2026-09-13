import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';

import settings from '../src/agent/settings.js';
import {
    readSchematic,
    toConstruction,
    materialList,
    unpackLitematicaLongs,
    readSpongeVarints,
    SchematicError,
} from '../src/utils/schematic.js';
import { library, ensureUserLibrary } from '../src/agent/schematics/library.js';

// ---------- fixture builders ----------

function gz(tag) {
    return zlib.gzipSync(nbt.writeUncompressed(tag, 'big'));
}

function long(v) {
    return { type: 'long', value: BigInt(v) };
}

// Compound VALUE object, as used inside a TAG_List of compounds (list
// children are raw values, not {type:'compound', value}-wrapped tags).
function stateValue(name, props = null) {
    const value = { Name: { type: 'string', value: name } };
    if (props) {
        value.Properties = {
            type: 'compound',
            value: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: 'string', value: v }])),
        };
    }
    return value;
}

/** Pack indices the Litematica way: entries may straddle long boundaries. */
function packLitematica(indices, bits) {
    const count = indices.length;
    const nLongs = Math.max(1, Math.ceil((count * bits) / 64));
    const longs = new Array(nLongs).fill(0n);
    const mask = (1n << BigInt(bits)) - 1n;
    for (let i = 0; i < count; i++) {
        const start = BigInt(i * bits);
        const li = Number(start / 64n);
        const off = Number(start % 64n);
        const value = BigInt(indices[i]) & mask;
        longs[li] |= value << BigInt(off);
        if (off + bits > 64) {
            longs[li + 1] |= value >> BigInt(64 - off);
        }
    }
    // NBT TAG_Long is signed.
    return longs.map((x) => BigInt.asIntN(64, x));
}

function makeLitematicBuffer(size, cellStates, { palettePrependAir = true, bits = null } = {}) {
    const { x: sx, y: sy, z: sz } = size;
    const nameMap = new Map();
    const rawPalette = palettePrependAir ? ['minecraft:air'] : [];
    for (const s of cellStates) {
        if (s && !nameMap.has(s.name)) {
            nameMap.set(s.name, rawPalette.length);
            rawPalette.push(s.name);
        }
    }
    const paletteTags = rawPalette.map((n) => {
        const props = n === 'minecraft:air' ? null : cellStates.find((s) => s && s.name === n)?.props;
        return stateValue(n, props || null);
    });
    const volume = sx * sy * sz;
    const indices = new Array(volume).fill(0);
    for (const s of cellStates) {
        if (!s) continue;
        indices[(s.y * sz + s.z) * sx + s.x] = nameMap.get(s.name);
    }
    const bpe = bits ?? Math.max(2, Math.ceil(Math.log2(paletteTags.length)));
    const data = packLitematica(indices, bpe);

    const root = {
        type: 'compound',
        name: '',
        value: {
            MinecraftDataVersion: { type: 'int', value: 3955 },
            Version: { type: 'int', value: 6 },
            Metadata: {
                type: 'compound',
                value: {
                    Name: { type: 'string', value: 'Test Tower' },
                    Author: { type: 'string', value: 'tester' },
                    Description: { type: 'string', value: 'a fixture' },
                },
            },
            Regions: {
                type: 'compound',
                value: {
                    Main: {
                        type: 'compound',
                        value: {
                            Position: {
                                type: 'compound',
                                value: { x: long(0), y: long(0), z: long(0) },
                            },
                            Size: {
                                type: 'compound',
                                value: { x: long(sx), y: long(sy), z: long(sz) },
                            },
                            BlockStatePalette: {
                                type: 'list',
                                value: { type: 'compound', value: paletteTags },
                            },
                            BlockStates: {
                                type: 'compound',
                                value: {
                                    data: { type: 'longArray', value: data },
                                    bits: long(bpe),
                                },
                            },
                        },
                    },
                },
            },
        },
    };
    return gz(root);
}

function writeVarint(n) {
    const out = [];
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n > 0) b |= 0x80;
        out.push(b);
    } while (n > 0);
    return out;
}

function makeSpongeBuffer(size, palette, cellStates) {
    const { x: sx, y: sy, z: sz } = size;
    const indexByName = new Map(Object.entries(palette).map(([n, i]) => [n, i]));
    const BlockData = [];
    for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
            for (let x = 0; x < sx; x++) {
                const cell = cellStates.find((c) => c.x === x && c.y === y && c.z === z);
                const id = cell ? indexByName.get(cell.name) : indexByName.get('minecraft:air');
                BlockData.push(...writeVarint(id));
            }
        }
    }
    const root = {
        type: 'compound',
        name: '',
        value: {
            Version: { type: 'int', value: 3 },
            DataVersion: { type: 'int', value: 3955 },
            Width: { type: 'short', value: sx },
            Height: { type: 'short', value: sy },
            Length: { type: 'short', value: sz },
            Palette: {
                type: 'compound',
                value: Object.fromEntries(
                    Object.entries(palette).map(([n, i]) => [n, { type: 'int', value: i }])
                ),
            },
            BlockData: { type: 'byteArray', value: BlockData.map((b) => (b > 127 ? b - 256 : b)) },
        },
    };
    return gz(root);
}

function makeStructureBuffer(size, palette, cellStates) {
    const blocks = cellStates.map((s, i) => ({
        pos: { type: 'intArray', value: [s.x, s.y, s.z] },
        state: { type: 'int', value: i + 1 },
    }));
    const root = {
        type: 'compound',
        name: '',
        value: {
            DataVersion: { type: 'int', value: 3955 },
            size: { type: 'intArray', value: [size.x, size.y, size.z] },
            palette: {
                type: 'list',
                value: { type: 'compound', value: palette.map((n) => stateValue(n)) },
            },
            blocks: {
                type: 'list',
                value: { type: 'compound', value: blocks },
            },
        },
    };
    return gz(root);
}

// ---------- packing primitives ----------

test('litematica packed longs unpack across long boundaries', () => {
    const indices = Array.from({ length: 100 }, (_, i) => i % 5);
    const bits = 3;
    const packed = packLitematica(indices, bits);
    const out = unpackLitematicaLongs(packed, bits, indices.length);
    assert.deepEqual([...out], indices);
});

test('sponge varint codec roundtrips multibyte values', () => {
    const values = [0, 1, 127, 128, 300, 255, 16384];
    const bytes = [];
    for (const v of values) bytes.push(...writeVarint(v));
    const out = readSpongeVarints(bytes.map((b) => (b > 127 ? b - 256 : b)), values.length);
    assert.deepEqual([...out], values);
});

// ---------- litematic ----------

test('parses a litematic: trim, voxels and material names', async () => {
    // 4x4x4 region, solid shell corners with empty borders in x/z
    const cells = [];
    for (let y = 0; y < 3; y++) {
        cells.push({ x: 1, y, z: 1, name: 'minecraft:stone' });
        cells.push({ x: 2, y, z: 2, name: 'minecraft:oak_planks' });
    }
    cells.push({ x: 1, y: 0, z: 2, name: 'minecraft:redstone_wire' });
    const buf = makeLitematicBuffer({ x: 4, y: 4, z: 4 }, cells);
    const sch = await readSchematic(buf, 'tower.litematic');

    assert.equal(sch.format, 'litematic');
    assert.equal(sch.name, 'Test Tower'); // Metadata.Name; the library renames to filename
    // empty x/z/x borders and top y layer trimmed away
    assert.deepEqual([sch.width, sch.height, sch.length], [2, 3, 2]);
    assert.deepEqual(sch.origin, { x: 1, y: 0, z: 1 });

    const { materials, skipped } = materialList(sch);
    assert.equal(materials.stone, 3);
    assert.equal(materials.oak_planks, 3);
    assert.equal(materials.redstone, 1); // item-name conversion
    assert.deepEqual(skipped, {});
});

test('litematic with straddling entries (3-bit palette, long row)', async () => {
    const cells = [];
    for (let i = 0; i < 50; i++) {
        cells.push({ x: i, y: 0, z: 0, name: i % 2 ? 'minecraft:dirt' : 'minecraft:grass_block' });
    }
    // five palette states => bits = 3, 50 entries cross long boundaries
    cells.push({ x: 0, y: 1, z: 0, name: 'minecraft:glass' });
    cells.push({ x: 1, y: 1, z: 0, name: 'minecraft:sand' });
    cells.push({ x: 2, y: 1, z: 0, name: 'minecraft:gravel' });
    const buf = makeLitematicBuffer({ x: 50, y: 2, z: 1 }, cells);
    const sch = await readSchematic(buf, 'row.litematic');
    assert.equal(sch.width, 50);
    const { materials } = materialList(sch);
    assert.equal(materials.dirt, 25);
    assert.equal(materials.grass_block, 25);
    assert.equal(materials.glass, 1);
    assert.equal(materials.sand, 1);
    assert.equal(materials.gravel, 1);
});

test('converts litematic to construction blueprint (air clears, no-item skips)', async () => {
    const cells = [
        { x: 0, y: 0, z: 0, name: 'minecraft:stone' },
        { x: 1, y: 0, z: 0, name: 'minecraft:farmland' }, // no block item
        { x: 0, y: 1, z: 0, name: 'minecraft:oak_planks' },
    ];
    const buf = makeLitematicBuffer({ x: 2, y: 2, z: 1 }, cells);
    const sch = await readSchematic(buf, 'mini.litematic');
    const { construction, skipped, unknown } = toConstruction(sch, { name: 'mini' });
    assert.equal(construction.offset, 0);
    assert.equal(construction.blocks[0][0][0], 'stone');
    assert.equal(construction.blocks[0][0][1], ''); // farmland skipped, terrain untouched
    assert.equal(construction.blocks[1][0][0], 'oak_planks');
    // empty spot within the trimmed bounds is explicit air (clear terrain)
    assert.equal(construction.blocks[1][0][1], 'air');
    assert.equal(skipped.farmland, 1);
    assert.deepEqual(unknown, {});
});

test('maps item-divergent block states and keeps plantable crops', async () => {
    const cells = [
        { x: 0, y: 0, z: 0, name: 'minecraft:wall_torch' },
        { x: 1, y: 0, z: 0, name: 'minecraft:oak_wall_sign' },
        { x: 2, y: 0, z: 0, name: 'minecraft:sugar_cane' },
    ];
    const buf = makeLitematicBuffer({ x: 3, y: 1, z: 1 }, cells);
    const sch = await readSchematic(buf, 'props.litematic');
    const { construction, skipped } = toConstruction(sch, { name: 'props' });
    assert.equal(construction.blocks[0][0][0], 'torch');
    assert.equal(construction.blocks[0][0][1], 'oak_sign');
    assert.equal(construction.blocks[0][0][2], 'sugar_cane');
    assert.deepEqual(skipped, {});
    const { materials } = materialList(sch);
    assert.equal(materials.torch, 1);
    assert.equal(materials.oak_sign, 1);
    assert.equal(materials.sugar_cane, 1);
});

test('unknown (newer-version) blocks are skipped + reported when resolving', async () => {
    const cells = [
        { x: 0, y: 0, z: 0, name: 'minecraft:stone' },
        { x: 1, y: 0, z: 0, name: 'minecraft:future_block' },
    ];
    const buf = makeLitematicBuffer({ x: 2, y: 1, z: 1 }, cells);
    const sch = await readSchematic(buf, 'future.litematic');
    const { construction, unknown } = toConstruction(sch, {
        resolve: (blockName) => blockName !== 'future_block',
    });
    assert.equal(construction.blocks[0][0][0], 'stone');
    assert.equal(construction.blocks[0][0][1], '');
    assert.equal(unknown.future_block, 1);
});

test('honours negative Size axis', async () => {
    const cells = [{ x: 0, y: 0, z: 0, name: 'minecraft:bricks' }];
    const buf = makeLitematicBuffer({ x: 1, y: 1, z: 1 }, cells);
    // Flip the x Size to negative: region then extends from Position.x=0
    // towards -x, and its local min corner must still resolve to x=0.
    const { parsed } = await nbt.parse(zlib.gunzipSync(buf));
    parsed.value.Regions.value.Main.value.Size.value.x.value = -1n;
    const sch = await readSchematic(zlib.gzipSync(nbt.writeUncompressed(parsed, 'big')), 'neg.litematic');
    assert.equal(sch.width, 1);
    assert.equal(sch.stateAt(0, 0, 0).name, 'minecraft:bricks');
});

test('merges multiple litematica regions into one enclosing voxel grid', async () => {
    const region = (rName, pos, cells, paletteNames) => {
        const palette = [stateValue('minecraft:air'), ...paletteNames.map((n) => stateValue(n))];
        const indices = cells.map((c) => c.state);
        const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
        return [rName, {
            type: 'compound',
            value: {
                Position: {
                    type: 'compound',
                    value: { x: long(pos.x), y: long(pos.y), z: long(pos.z) },
                },
                Size: {
                    type: 'compound',
                    value: { x: long(1), y: long(1), z: long(1) },
                },
                BlockStatePalette: { type: 'list', value: { type: 'compound', value: palette } },
                BlockStates: {
                    type: 'compound',
                    value: {
                        data: { type: 'longArray', value: packLitematica(indices, bits) },
                        bits: long(bits),
                    },
                },
            },
        }];
    };
    const [n1, r1] = region('A', { x: 0, y: 0, z: 0 }, [{ state: 1 }], ['minecraft:stone']);
    const [n2, r2] = region('B', { x: 3, y: 1, z: 0 }, [{ state: 1 }], ['minecraft:glass']);
    const root = {
        type: 'compound', name: '',
        value: {
            Version: { type: 'int', value: 6 },
            Regions: { type: 'compound', value: { [n1]: r1, [n2]: r2 } },
        },
    };
    const sch = await readSchematic(gz(root), 'multi.litematic');
    assert.deepEqual([sch.width, sch.height, sch.length], [4, 2, 1]);
    assert.equal(sch.stateAt(0, 0, 0).name, 'minecraft:stone');
    assert.equal(sch.stateAt(3, 1, 0).name, 'minecraft:glass');
    assert.equal(sch.stateAt(1, 0, 0), null);
    const { materials } = materialList(sch);
    assert.equal(materials.stone, 1);
    assert.equal(materials.glass, 1);
});

// ---------- sponge ----------

test('parses a sponge .schem (WorldEdit/Baritone format)', async () => {
    const palette = { 'minecraft:air': 0, 'minecraft:stone_bricks': 1, 'minecraft:glass': 2 };
    const cells = [
        { x: 0, y: 0, z: 0, name: 'minecraft:stone_bricks' },
        { x: 1, y: 0, z: 0, name: 'minecraft:stone_bricks' },
        { x: 0, y: 1, z: 0, name: 'minecraft:glass' },
    ];
    const buf = makeSpongeBuffer({ x: 2, y: 2, z: 1 }, palette, cells);
    const sch = await readSchematic(buf, 'house.schem');
    assert.equal(sch.format, 'sponge');
    assert.deepEqual([sch.width, sch.height, sch.length], [2, 2, 1]);
    assert.equal(sch.stateAt(0, 0, 0).name, 'minecraft:stone_bricks');
    assert.equal(sch.stateAt(0, 1, 0).name, 'minecraft:glass');
    assert.equal(sch.stateAt(1, 1, 0), null);
});

// ---------- vanilla structure ----------

test('parses a vanilla structure .nbt', async () => {
    const palette = ['minecraft:air', 'minecraft:oak_log', 'minecraft:oak_planks'];
    const blocksTags = [
        { pos: { type: 'intArray', value: [0, 0, 0] }, state: { type: 'int', value: 1 } },
        { pos: { type: 'intArray', value: [1, 1, 1] }, state: { type: 'int', value: 2 } },
    ];
    const root = {
        type: 'compound', name: '',
        value: {
            size: { type: 'intArray', value: [2, 2, 2] },
            palette: { type: 'list', value: { type: 'compound', value: palette.map((n) => stateValue(n)) } },
            blocks: { type: 'list', value: { type: 'compound', value: blocksTags } },
        },
    };
    const sch = await readSchematic(gz(root), 'treehouse.nbt');
    assert.equal(sch.format, 'structure');
    assert.equal(sch.stateAt(0, 0, 0).name, 'minecraft:oak_log');
    assert.equal(sch.stateAt(1, 1, 1).name, 'minecraft:oak_planks');
});

// ---------- error handling ----------

test('rejects unsupported extensions and empty files', async () => {
    await assert.rejects(() => readSchematic(Buffer.from('x'), 'old.schematic'), SchematicError);
    const empty = makeLitematicBuffer({ x: 1, y: 1, z: 1 }, []);
    await assert.rejects(() => readSchematic(empty, 'empty.litematic'), /no blocks/);
});

// ---------- library ----------

let tmpDir;
let prevLib;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-schem-'));
    prevLib = settings.schematic_library;
    settings.schematic_library = tmpDir;
    library.scan();
});

afterEach(() => {
    settings.schematic_library = prevLib;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    library.scan();
});

test('library browses files, resolves fuzzy names and describes builds', async () => {
    const cells = [
        { x: 0, y: 0, z: 0, name: 'minecraft:cobblestone' },
        { x: 1, y: 0, z: 0, name: 'minecraft:cobblestone' },
        { x: 0, y: 1, z: 0, name: 'minecraft:oak_planks' },
    ];
    fs.writeFileSync(path.join(tmpDir, 'Cottage.litematic'), makeLitematicBuffer({ x: 2, y: 2, z: 1 }, cells));
    fs.writeFileSync(path.join(tmpDir, 'blue.json'), JSON.stringify({
        name: 'blue', offset: 0,
        blocks: [[['stone', 'stone']], [['air', 'stone']]],
    }));
    fs.writeFileSync(path.join(tmpDir, 'ignore.txt'), 'nope');

    const names = library.scan();
    assert.ok(names.includes('Cottage'));
    assert.ok(names.includes('blue'));
    assert.ok(!names.includes('ignore'));

    // extension and case tolerance
    assert.ok(library.resolve('cottage.LITEMATIC'));
    assert.ok(library.resolve('COTT'));

    const info = await library.describe('Cottage.litematic');
    assert.equal(info.format, 'litematic');
    assert.equal(info.width, 2);
    assert.equal(info.total, 3);
    assert.equal(info.materials.cobblestone, 2);
});

test('library produces buildable constructions and serves repeated calls', async () => {
    const cells = [{ x: 0, y: 0, z: 0, name: 'minecraft:stone' }];
    fs.writeFileSync(path.join(tmpDir, 'rock.litematic'), makeLitematicBuffer({ x: 1, y: 1, z: 1 }, cells));
    library.scan();
    const first = await library.getConstruction('rock');
    assert.equal(first.construction.blocks[0][0][0], 'stone');
    const second = await library.getConstruction('rock');
    assert.equal(second.construction.blocks[0][0][0], 'stone');
    // unknown build resolves to null rather than throwing
    assert.equal(await library.getConstruction('does-not-exist'), null);
});

test('ensureUserLibrary seeds a README on first use', () => {
    const fresh = path.join(tmpDir, 'freshlib');
    settings.schematic_library = fresh;
    ensureUserLibrary();
    assert.ok(fs.existsSync(path.join(fresh, 'README.md')));
    ensureUserLibrary(); // idempotent
});
