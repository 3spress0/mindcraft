import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    packLitematicaLongs,
    toLitematicNBT,
    writeLitematic,
    writeLitematicFile,
    qualifyStateName,
    describeModel,
} from '../src/utils/litematic_writer.js';
import {
    readSchematic,
    unpackLitematicaLongs,
    VOID,
} from '../src/utils/schematic.js';

// ---------- helpers ----------

function makeModel(voxelFill, palette, { width = 3, height = 2, length = 3, tileEntities = [] } = {}) {
    const voxels = new Uint32Array(width * height * length);
    for (let i = 0; i < voxels.length; i++) {
        voxels[i] = typeof voxelFill === 'function' ? voxelFill(i, width, height, length) : voxelFill;
    }
    return {
        format: 'test',
        name: 'model',
        width,
        height,
        length,
        origin: { x: 0, y: 0, z: 0 },
        voxels,
        palette,
        tileEntities,
    };
}

// ---------- pack/unpack ----------

test('packLitematicaLongs round-trips with unpack for straddling bit widths', () => {
    for (const bits of [1, 2, 3, 5, 7, 13, 21]) {
        const maxId = (1 << bits) - 1;
        const count = 71; // odd count forces straddling for most widths
        const indices = Uint32Array.from({ length: count }, (_, i) => (i * 13 + bits) % (maxId + 1));
        const packed = packLitematicaLongs(indices, bits);
        const unpacked = unpackLitematicaLongs(packed, bits, count);
        assert.deepEqual(Array.from(unpacked), Array.from(indices), `bits=${bits}`);
    }
});

test('packLitematicaLongs produces the minimal number of longs', () => {
    const packed = packLitematicaLongs([0, 1, 2, 3], 2);
    assert.equal(packed.length, 1);
    const packed2 = packLitematicaLongs(new Array(64).fill(1), 3);
    assert.equal(packed2.length, 3); // 64*3 bits = 3 longs
});

test('packLitematicaLongs rejects invalid bit widths', () => {
    assert.throws(() => packLitematicaLongs([1], 0));
});

// ---------- NBT shape ----------

test('toLitematicNBT produces air-first palette and metadata', () => {
    const palette = [
        { name: 'stone', props: {} },
        { name: 'oak_stairs', props: { facing: 'north', half: 'bottom' } },
    ];
    const model = makeModel((i) => (i % 2 === 0 ? 0 : 1), palette, {
        tileEntities: [{ id: 'chest', x: 1, y: 0, z: 1 }],
    });
    const tag = toLitematicNBT(model, { name: 'hut', author: 'tester', now: 1700000000000 });

    const root = tag.value;
    assert.equal(root.Metadata.value.Name.value, 'hut');
    assert.equal(root.Metadata.value.Author.value, 'tester');
    assert.equal(root.Metadata.value.TimeCreated.value, 1700000000000n);
    assert.equal(root.Metadata.value.RegionCount.value, 1);

    const region = root.Regions.value.main.value;
    assert.equal(region.Size.value.x.value, 3);
    assert.equal(region.Size.value.y.value, 2);
    assert.equal(region.Size.value.z.value, 3);

    const paletteValues = region.BlockStatePalette.value.value;
    assert.equal(paletteValues[0].Name.value, 'minecraft:air', 'air must be palette index 0');
    assert.equal(paletteValues[1].Name.value, 'minecraft:stone');
    assert.equal(paletteValues[2].Name.value, 'minecraft:oak_stairs');
    assert.equal(paletteValues[2].Properties.value.facing.value, 'north');

    assert.equal(region.BlockEntities.value.value.length, 1);
    assert.equal(region.BlockEntities.value.value[0].id.value, 'minecraft:chest');
});

test('toLitematicNBT rejects empty/invalid models', () => {
    assert.throws(() => toLitematicNBT(null));
    assert.throws(() => toLitematicNBT({ voxels: new Uint32Array(0), palette: [], width: 0, height: 1, length: 1 }));
});

test('qualifyStateName keeps namespaced names intact', () => {
    assert.equal(qualifyStateName('stone'), 'minecraft:stone');
    assert.equal(qualifyStateName('minecraft:stone'), 'minecraft:stone');
    assert.equal(qualifyStateName('mymod:fancy'), 'mymod:fancy');
});

// ---------- full write -> read round-trip ----------

test('writeLitematic round-trips through readSchematic', async () => {
    const palette = [
        { name: 'stone', props: {} },
        { name: 'oak_planks', props: {} },
        { name: 'oak_stairs', props: { facing: 'east', half: 'top', shape: 'straight' } },
        { name: 'glass', props: {} },
        { name: 'redstone_wire', props: { power: '3' } },
    ];
    // 5 states + air = 6 palette entries -> 3 bits per entry (straddles longs).
    const width = 4, height = 3, length = 4;
    const model = makeModel(
        (i) => (i % 7 === 0 ? VOID : i % palette.length),
        palette,
        { width, height, length, tileEntities: [{ id: 'minecraft:furnace', x: 0, y: 0, z: 0 }] },
    );

    const buffer = writeLitematic(model, { name: 'roundtrip', author: 'mindcraft', description: 'test build', now: 1710000000000 });
    const parsed = await readSchematic(buffer, 'roundtrip.litematic');

    assert.equal(parsed.format, 'litematic');
    assert.equal(parsed.name, 'roundtrip');
    assert.equal(parsed.author, 'mindcraft');
    assert.equal(parsed.description, 'test build');
    assert.equal(parsed.width, width);
    assert.equal(parsed.height, height);
    assert.equal(parsed.length, length);

    for (let y = 0; y < height; y++) {
        for (let z = 0; z < length; z++) {
            for (let x = 0; x < width; x++) {
                const i = (y * length + z) * width + x;
                const want = model.voxels[i] === VOID ? null : palette[model.voxels[i]];
                const got = parsed.stateAt(x, y, z);
                if (!want) {
                    assert.equal(got, null, `cell ${x},${y},${z} should be empty`);
                } else {
                    assert.ok(got, `cell ${x},${y},${z} should be ${want.name}`);
                    assert.equal(got.name, `minecraft:${want.name}`);
                    assert.deepEqual(got.props, want.props);
                }
            }
        }
    }

    assert.deepEqual(parsed.tileEntities, [{ id: 'minecraft:furnace', x: 0, y: 0, z: 0 }]);
});

test('writeLitematicFile writes a readable file', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-'));
    const file = path.join(dir, 'nested', 'build.litematic');

    const model = makeModel(0, [{ name: 'stone', props: {} }]);
    writeLitematicFile(model, file, { name: 'build' });
    assert.ok(fs.existsSync(file));

    const parsed = await readSchematic(fs.readFileSync(file), 'build.litematic');
    assert.equal(parsed.name, 'build');
    assert.ok(parsed.stateAt(0, 0, 0));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('describeModel counts materials with item renames', () => {
    const palette = [
        { name: 'redstone_wire', props: { power: '0' } },
        { name: 'wall_torch', props: { facing: 'north' } },
        { name: 'stone', props: {} },
    ];
    const model = makeModel((i) => i % palette.length, palette);
    const desc = describeModel(model);
    assert.ok(desc.materials.redstone > 0, 'redstone_wire should count as redstone items');
    assert.ok(desc.materials.torch > 0, 'wall_torch should count as torch items');
    assert.ok(desc.materials.stone > 0);
    assert.equal(desc.width, model.width);
});
