import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    encodeVarint,
    stateToString,
    toSpongeNBT,
    writeSponge,
    writeSpongeFile,
} from '../src/utils/sponge_writer.js';
import { readSchematic, readSpongeVarints, VOID } from '../src/utils/schematic.js';

// ---------- varints ----------

test('encodeVarint produces LEB128 bytes the reader decodes', () => {
    for (const value of [0, 1, 127, 128, 300, 16384, 2_000_000]) {
        const bytes = encodeVarint(value, []);
        const decoded = readSpongeVarints(Uint8Array.from(bytes), 1);
        assert.equal(decoded[0], value, `value ${value}`);
    }
});

test('encodeVarint appends into an existing buffer', () => {
    const out = [0xAA];
    encodeVarint(300, out);
    assert.equal(out[0], 0xAA);
    assert.equal(readSpongeVarints(Uint8Array.from(out.slice(1)), 1)[0], 300);
});

// ---------- state strings ----------

test('stateToString qualifies names and sorts properties', () => {
    assert.equal(stateToString({ name: 'stone', props: {} }), 'minecraft:stone');
    assert.equal(
        stateToString({ name: 'minecraft:oak_stairs', props: { half: 'bottom', facing: 'north', shape: 'straight' } }),
        'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]',
    );
});

// ---------- NBT shape ----------

function makeModel(voxelFill, palette, { width = 3, height = 2, length = 3 } = {}) {
    const voxels = new Uint32Array(width * height * length);
    for (let i = 0; i < voxels.length; i++) {
        voxels[i] = typeof voxelFill === 'function' ? voxelFill(i) : voxelFill;
    }
    return { format: 'test', name: 'model', width, height, length, origin: { x: 0, y: 0, z: 0 }, voxels, palette, tileEntities: [] };
}

test('toSpongeNBT emits spec v2 with air-first palette', () => {
    const model = makeModel((i) => (i % 2 === 0 ? 0 : 1), [
        { name: 'stone', props: {} },
        { name: 'glass', props: {} },
    ]);
    const tag = toSpongeNBT(model, { name: 'hut' });
    const root = tag.value;
    assert.equal(root.Version.value, 2);
    assert.equal(root.Width.value, 3);
    assert.equal(root.Height.value, 2);
    assert.equal(root.Length.value, 3);
    assert.equal(root.PaletteMax.value, 3); // air + 2 states

    const paletteKeys = Object.keys(root.Palette.value);
    assert.ok(paletteKeys.includes('minecraft:air'));
    assert.equal(root.Palette.value['minecraft:air'].value, 0);
    assert.equal(root.Palette.value['minecraft:stone'].value, 1);
    assert.equal(root.Metadata.value.Name.value, 'hut');
});

test('toSpongeNBT rejects invalid models', () => {
    assert.throws(() => toSpongeNBT(null));
    assert.throws(() => toSpongeNBT({ voxels: new Uint32Array(0), palette: [], width: 0, height: 1, length: 1 }));
});

// ---------- full round-trip ----------

test('writeSponge round-trips through readSchematic', async () => {
    const palette = [
        { name: 'stone', props: {} },
        { name: 'oak_stairs', props: { facing: 'east', half: 'top' } },
        { name: 'minecraft:glass', props: {} },
    ];
    const width = 4, height = 3, length = 4;
    const model = makeModel((i) => (i % 6 === 0 ? VOID : i % palette.length), palette, { width, height, length });

    const parsed = await readSchematic(writeSponge(model, { name: 'roundtrip' }), 'rt.schem');
    assert.equal(parsed.format, 'sponge');
    assert.equal(parsed.name, 'roundtrip');
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
                    assert.equal(got, null);
                } else {
                    assert.ok(got, `cell ${x},${y},${z}`);
                    assert.equal(got.name, want.name.includes(':') ? want.name : `minecraft:${want.name}`);
                    assert.deepEqual(got.props, want.props);
                }
            }
        }
    }
});

test('writeSpongeFile writes a readable file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schem-'));
    const file = path.join(dir, 'nested', 'build.schem');
    const model = makeModel(0, [{ name: 'stone', props: {} }]);
    writeSpongeFile(model, file, { name: 'build' });
    assert.ok(fs.existsSync(file));
    const parsed = await readSchematic(fs.readFileSync(file), 'build.schem');
    assert.equal(parsed.name, 'build');
    fs.rmSync(dir, { recursive: true, force: true });
});
