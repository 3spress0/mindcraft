/**
 * capture.js
 *
 * Litematica-style area selection for mindcraft: capture a box of the live
 * world into a normalized schematic model and save it as a .litematic file
 * in the build library. The bot can then re-build it, quote materials for
 * it, or hand the file to a human Litematica user.
 *
 * Only loaded blocks are read (bot.blockAt), nothing is modified: this is a
 * legit observer-style capture. Unloaded or air-like cells are skipped.
 */

import fs from 'fs';
import path from 'path';
import { Vec3 } from 'vec3';
import { VOID, AIR_LIKE } from '../../utils/schematic.js';
import { writeLitematicFile, describeModel } from '../../utils/litematic_writer.js';
import { library, userLibraryDir } from './library.js';

// Safety caps so a mis-typed coordinate can't produce a gigabyte capture.
export const MAX_CAPTURE_VOLUME = 262144; // e.g. 64 x 64 x 64
export const MAX_CAPTURE_EDGE = 256;

/**
 * Normalize two corners into a min/max box (inclusive on both ends).
 */
export function normalizeCorners(p1, p2) {
    const a = new Vec3(Math.floor(p1.x), Math.floor(p1.y), Math.floor(p1.z));
    const b = new Vec3(Math.floor(p2.x), Math.floor(p2.y), Math.floor(p2.z));
    return {
        min: new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
        max: new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
    };
}

/**
 * Capture a world box into a normalized schematic model.
 * @param {Object} bot  mineflayer bot
 * @param {Object} p1   first corner {x,y,z}
 * @param {Object} p2   second corner {x,y,z}
 * @param {Object} opts { maxVolume, maxEdge }
 * @returns normalized schematic model (readSchematic shape)
 */
export function captureArea(bot, p1, p2, opts = {}) {
    const maxVolume = opts.maxVolume ?? MAX_CAPTURE_VOLUME;
    const maxEdge = opts.maxEdge ?? MAX_CAPTURE_EDGE;
    const { min, max } = normalizeCorners(p1, p2);

    const width = max.x - min.x + 1;
    const height = max.y - min.y + 1;
    const length = max.z - min.z + 1;
    if (Math.max(width, height, length) > maxEdge) {
        throw new Error(`Capture box too large: ${width}x${height}x${length} (max edge ${maxEdge}).`);
    }
    if (width * height * length > maxVolume) {
        throw new Error(`Capture box has ${width * height * length} blocks; the limit is ${maxVolume}.`);
    }

    const palette = [];
    const paletteMap = new Map();
    const voxels = new Uint32Array(width * height * length).fill(VOID);
    let unloaded = 0;
    let placed = 0;

    const intern = (name, props) => {
        const key = name + ' ' + JSON.stringify(props);
        let id = paletteMap.get(key);
        if (id === undefined) {
            id = palette.length;
            palette.push({ name, props });
            paletteMap.set(key, id);
        }
        return id;
    };

    for (let y = 0; y < height; y++) {
        for (let z = 0; z < length; z++) {
            for (let x = 0; x < width; x++) {
                const worldPos = new Vec3(min.x + x, min.y + y, min.z + z);
                let block = null;
                try {
                    block = bot.blockAt(worldPos, false);
                } catch {
                    block = null;
                }
                if (!block) {
                    unloaded++;
                    continue;
                }
                const base = String(block.name || 'air');
                if (AIR_LIKE.has(base)) continue;
                let props = {};
                try {
                    if (typeof block.getProperties === 'function') {
                        const p = block.getProperties();
                        if (p && typeof p === 'object') {
                            for (const k of Object.keys(p)) props[k] = String(p[k]);
                        }
                    }
                } catch {
                    props = {};
                }
                voxels[(y * length + z) * width + x] = intern(base, props);
                placed++;
            }
        }
    }

    if (placed === 0) {
        throw new Error(unloaded > 0
            ? 'Capture found no blocks: the area appears unloaded or entirely air.'
            : 'Capture found no blocks: the area is entirely air.');
    }

    const model = {
        format: 'capture',
        name: 'capture',
        author: '',
        description: '',
        width,
        height,
        length,
        origin: { x: min.x, y: min.y, z: min.z },
        voxels,
        palette,
        tileEntities: [],
        capture: { min, max, unloaded },
    };
    model.stateAt = function (x, y, z) {
        if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) return null;
        const id = voxels[(y * length + z) * width + x];
        return id === VOID ? null : palette[id];
    };
    return model;
}

/** Turn a capture name into a safe library file stem. */
export function sanitizeCaptureName(name) {
    const clean = String(name || '').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_ -]/g, '_').trim().replace(/\s+/g, '_');
    return clean || `capture_${Date.now()}`;
}

/**
 * Capture a world box and save it as `<name>.litematic` in the user's build
 * library. Refuses to overwrite existing library entries.
 * @returns {Object} { file, name, width, height, length, totalBlocks, materials, unloaded }
 */
export function saveAreaAsLitematic(bot, name, p1, p2, { author, description, minecraftDataVersion } = {}) {
    const key = sanitizeCaptureName(name);
    const dir = userLibraryDir();
    const file = path.join(dir, `${key}.litematic`);
    if (fs.existsSync(file)) {
        throw new Error(`A build named "${key}" already exists in the library; pick a different name.`);
    }

    const model = captureArea(bot, p1, p2);
    writeLitematicFile(model, file, {
        name: key,
        author: author || bot.username || 'mindcraft',
        description: description || `Captured by ${bot.username || 'mindcraft'} at (${model.origin.x}, ${model.origin.y}, ${model.origin.z})`,
        minecraftDataVersion,
    });

    // Make it immediately available to !listBuilds / !buildSchematic.
    try {
        library.scan();
    } catch { /* scan failure is non-fatal: the file is already on disk */ }

    const summary = describeModel(model);
    return {
        file,
        name: key,
        width: summary.width,
        height: summary.height,
        length: summary.length,
        totalBlocks: summary.totalBlocks,
        materials: summary.materials,
        skipped: summary.skipped,
        unloaded: model.capture.unloaded,
    };
}
