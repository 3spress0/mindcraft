/**
 * litematic_writer.js
 *
 * Writer side of the Litematica integration. Serializes a normalized voxel
 * model (the same shape `readSchematic` in schematic.js produces) into a
 * valid `.litematic` file:
 *
 *   - NBT root, big-endian, gzip compressed
 *   - Metadata block (name/author/description/enclosing size/timestamps)
 *   - one region with a block-state palette and variable-bit packed longs
 *     where entries are allowed to straddle 64-bit long boundaries —
 *     the exact convention of Litematica's LitematicaBitArray.
 *
 * Files produced here load in the Litematica mod and round-trip through
 * `readSchematic`, so the bot can capture an area of its own world, save it,
 * and later re-build or quote materials for it like any dropped schematic.
 *
 * Format reference: https://github.com/maruohon/litematica/wiki
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import { VOID, AIR_LIKE, materialList } from './schematic.js';

// Litematica file-format version and a representative Minecraft data version.
// The mod uses these for upgrade paths only; both are safe defaults.
const LITEMATIC_VERSION = 6;
const DEFAULT_MINECRAFT_DATA_VERSION = 3700; // 1.20.4

function ceilLog2(n) {
    let b = 0;
    while ((1 << b) < n) b++;
    return b;
}

/**
 * Pack palette indices the Litematica way. Inverse of unpackLitematicaLongs:
 * entries may straddle two longs and are written with unsigned little-endian
 * bit order inside each long. Returns signed 64-bit longs (Java semantics).
 * @param {Uint32Array|number[]} indices palette indices
 * @param {number} bitsPerEntry bits used per entry (>= 1)
 * @returns {bigint[]}
 */
export function packLitematicaLongs(indices, bitsPerEntry) {
    if (bitsPerEntry < 1) throw new Error(`Invalid bits-per-entry: ${bitsPerEntry}`);
    const count = indices.length;
    const nLongs = Math.max(1, Math.ceil((count * bitsPerEntry) / 64));
    const longs = new Array(nLongs).fill(0n);
    const mask = (1n << BigInt(bitsPerEntry)) - 1n;
    const low64 = (1n << 64n) - 1n;
    const bits = BigInt(bitsPerEntry);
    for (let i = 0; i < count; i++) {
        const value = BigInt(indices[i] >>> 0) & mask;
        const start = BigInt(i) * bits;
        const longIndex = Number(start / 64n);
        const bitOffset = Number(start % 64n);
        longs[longIndex] = (longs[longIndex] | (value << BigInt(bitOffset))) & low64;
        if (bitOffset + bitsPerEntry > 64) {
            longs[longIndex + 1] = (longs[longIndex + 1] | (value >> BigInt(64 - bitOffset))) & low64;
        }
    }
    return longs.map((v) => BigInt.asIntN(64, v));
}

function str(v) {
    return { type: 'string', value: String(v ?? '') };
}

function int(v) {
    return { type: 'int', value: Math.trunc(Number(v)) };
}

function long(v) {
    return { type: 'long', value: BigInt(Math.trunc(Number(v || 0))) };
}

function compound(value) {
    return { type: 'compound', value };
}

function xyz(x, y, z) {
    return compound({ x: int(x), y: int(y), z: int(z) });
}

function stateTag(state) {
    const value = { Name: str(state.name) };
    const props = state.props || {};
    const keys = Object.keys(props);
    if (keys.length > 0) {
        const pv = {};
        for (const k of keys) pv[k] = str(props[k]);
        value.Properties = compound(pv);
    }
    return value;
}

/**
 * Serialize a palette entry name, guarding the minecraft: namespace.
 */
export function qualifyStateName(name) {
    return name.includes(':') ? name : `minecraft:${name}`;
}

/**
 * Build the Litematica NBT tag tree for a normalized schematic model.
 * @param {Object} model normalized schematic (see schematic.js NormalizedSchematic)
 * @param {Object} meta  { name, author, description, regionName, now, minecraftDataVersion }
 * @returns NBT tag ready for nbt.writeUncompressed(tag, 'big')
 */
export function toLitematicNBT(model, meta = {}) {
    if (!model || !model.voxels || !model.palette) {
        throw new Error('toLitematicNBT requires a normalized schematic model');
    }
    const { width, height, length } = model;
    if (width < 1 || height < 1 || length < 1) {
        throw new Error(`Invalid schematic dimensions: ${width}x${height}x${length}`);
    }

    // Palette: air first (Litematica convention), then every state in use.
    const paletteValues = [{ Name: str('minecraft:air') }];
    const paletteIndex = new Map(); // model palette id -> litematic index
    for (let id = 0; id < model.palette.length; id++) {
        const state = model.palette[id];
        const base = state.name.split(':').pop();
        if (AIR_LIKE.has(base)) continue;
        paletteIndex.set(id, paletteValues.length);
        paletteValues.push(stateTag({ ...state, name: qualifyStateName(state.name) }));
    }
    const bitsPerEntry = Math.max(2, ceilLog2(paletteValues.length));

    // Packed voxels; VOID and air cells map to palette index 0.
    const indices = new Uint32Array(model.voxels.length);
    for (let i = 0; i < model.voxels.length; i++) {
        const id = model.voxels[i];
        indices[i] = id === VOID ? 0 : (paletteIndex.get(id) ?? 0);
    }
    const packed = packLitematicaLongs(indices, bitsPerEntry);

    // Tile entities: only positional id markers; Litematica tolerates the
    // absence of full block-entity NBT.
    const blockEntityValues = (model.tileEntities || []).map((t) => ({
        id: str(qualifyStateName(t.id)),
        x: int(t.x),
        y: int(t.y),
        z: int(t.z),
        pos: { type: 'list', value: { type: 'int', value: [t.x, t.y, t.z] } },
    }));

    const now = Number(meta.now ?? Date.now());
    const regionName = meta.regionName || 'main';

    const regionValue = {
        Position: xyz(0, 0, 0),
        Size: xyz(width, height, length),
        BlockStatePalette: { type: 'list', value: { type: 'compound', value: paletteValues } },
        BlockStates: { type: 'longArray', value: packed },
    };
    if (blockEntityValues.length > 0) {
        regionValue.BlockEntities = { type: 'list', value: { type: 'compound', value: blockEntityValues } };
    }

    let blockCount = 0;
    for (const id of model.voxels) if (id !== VOID) blockCount++;

    return {
        type: 'compound',
        name: '',
        value: {
            Version: int(LITEMATIC_VERSION),
            MinecraftDataVersion: int(meta.minecraftDataVersion ?? DEFAULT_MINECRAFT_DATA_VERSION),
            Metadata: compound({
                Author: str(meta.author ?? 'mindcraft'),
                Description: str(meta.description ?? ''),
                Name: str(meta.name ?? model.name ?? 'schematic'),
                RegionCount: int(1),
                TimeCreated: long(now),
                TimeModified: long(now),
                EnclosingSize: xyz(width, height, length),
                TotalBlocks: int(blockCount),
            }),
            Regions: compound({
                [regionName]: compound(regionValue),
            }),
        },
    };
}

/**
 * Serialize a normalized schematic model to a gzip-compressed .litematic buffer.
 * @param {Object} model normalized schematic model
 * @param {Object} meta  metadata overrides (see toLitematicNBT)
 * @returns {Buffer}
 */
export function writeLitematic(model, meta = {}) {
    const tag = toLitematicNBT(model, meta);
    return zlib.gzipSync(nbt.writeUncompressed(tag, 'big'));
}

/** Write a .litematic file to disk, creating parent folders as needed. */
export function writeLitematicFile(model, filePath, meta = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, writeLitematic(model, meta));
    return filePath;
}

/**
 * Summarize a model the way capture/save report it back to the player.
 */
export function describeModel(model) {
    const { materials, skipped } = materialList(model);
    let total = 0;
    for (const n of Object.values(materials)) total += n;
    return {
        width: model.width,
        height: model.height,
        length: model.length,
        totalBlocks: total,
        materials,
        skipped,
    };
}
