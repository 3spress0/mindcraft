/**
 * sponge_writer.js
 *
 * Writer side of the Sponge schematic format (`.schem`, spec v2) — the format
 * WorldEdit saves and Baritone builds natively. Counterpart of
 * `parseSponge` in schematic.js: serializes a normalized voxel model into
 *
 *   - NBT root, big-endian, gzip compressed
 *   - Width/Height/Length shorts + a Palette compound mapping full block-state
 *     strings ("minecraft:oak_stairs[facing=north,...]") to varint indices
 *   - BlockData as unsigned LEB128 varints, litematic index order
 *     ((y*length+z)*width+x)
 *
 * Round-trips through `readSchematic`, so captures can be saved as `.schem`
 * for WorldEdit/Baritone users just like `.litematic` ones.
 *
 * Format reference: https://github.com/SpongePowered/Schematic-Specification
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import { VOID, AIR_LIKE } from './schematic.js';
import { qualifyStateName } from './litematic_writer.js';

const SPONGE_VERSION = 2;
const DEFAULT_DATA_VERSION = 3700; // 1.20.4

/** Encode one unsigned LEB128 varint into a byte array (in place). */
export function encodeVarint(value, out) {
    let v = value >>> 0;
    while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v & 0x7f);
    return out;
}

/** Full block-state string for a palette entry: name + sorted properties. */
export function stateToString(state) {
    const name = qualifyStateName(state.name);
    const props = state.props || {};
    const keys = Object.keys(props).sort();
    if (keys.length === 0) return name;
    return `${name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]`;
}

/**
 * Build the Sponge schematic NBT tree for a normalized model.
 * @param {Object} model normalized schematic (see schematic.js)
 * @param {Object} meta  { name, author, dataVersion, now }
 */
export function toSpongeNBT(model, meta = {}) {
    if (!model || !model.voxels || !model.palette) {
        throw new Error('toSpongeNBT requires a normalized schematic model');
    }
    const { width, height, length } = model;
    if (width < 1 || height < 1 || length < 1) {
        throw new Error(`Invalid schematic dimensions: ${width}x${height}x${length}`);
    }

    // Palette: air at index 0, then every distinct state in use.
    const paletteStrings = ['minecraft:air'];
    const paletteIndex = new Map(); // model palette id -> sponge index
    for (let id = 0; id < model.palette.length; id++) {
        const state = model.palette[id];
        if (AIR_LIKE.has(state.name.split(':').pop())) continue;
        paletteIndex.set(id, paletteStrings.length);
        paletteStrings.push(stateToString(state));
    }

    // BlockData: one varint per voxel.
    const bytes = [];
    for (let i = 0; i < model.voxels.length; i++) {
        const id = model.voxels[i];
        encodeVarint(id === VOID ? 0 : (paletteIndex.get(id) ?? 0), bytes);
    }

    const paletteValue = {};
    for (let i = 0; i < paletteStrings.length; i++) {
        paletteValue[paletteStrings[i]] = { type: 'int', value: i };
    }

    const blockEntityValues = (model.tileEntities || []).map((t) => ({
        Id: { type: 'string', value: qualifyStateName(t.id) },
        Pos: { type: 'list', value: { type: 'int', value: [t.x, t.y, t.z] } },
    }));

    const root = {
        Version: { type: 'int', value: SPONGE_VERSION },
        DataVersion: { type: 'int', value: meta.dataVersion ?? DEFAULT_DATA_VERSION },
        Width: { type: 'short', value: width },
        Height: { type: 'short', value: height },
        Length: { type: 'short', value: length },
        Offset: { type: 'list', value: { type: 'int', value: [0, 0, 0] } },
        PaletteMax: { type: 'int', value: paletteStrings.length },
        Palette: { type: 'compound', value: paletteValue },
        BlockData: { type: 'byteArray', value: Uint8Array.from(bytes) },
        Metadata: {
            type: 'compound',
            value: {
                Name: { type: 'string', value: String(meta.name ?? model.name ?? 'schematic') },
                Author: { type: 'string', value: String(meta.author ?? 'mindcraft') },
            },
        },
    };
    if (blockEntityValues.length > 0) {
        root.BlockEntities = { type: 'list', value: { type: 'compound', value: blockEntityValues } };
    }

    return { type: 'compound', name: '', value: root };
}

/** Serialize a normalized model to a gzip-compressed .schem buffer. */
export function writeSponge(model, meta = {}) {
    const tag = toSpongeNBT(model, meta);
    return zlib.gzipSync(nbt.writeUncompressed(tag, 'big'));
}

/** Write a .schem file to disk, creating parent folders as needed. */
export function writeSpongeFile(model, filePath, meta = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, writeSponge(model, meta));
    return filePath;
}
